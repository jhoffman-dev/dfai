import { fileTitle, fitStem, shortHash } from '../../meetings/mapping/meeting-file-name.ts';
import { MeetingMappingError } from '../../meetings/mapping/meeting-mapping-error.ts';
import { wallClockIn } from '../../meetings/mapping/meeting-when.ts';
import { escapeMarkdown, markdownLink, slackToMarkdown, slackToPlain } from './capture-mrkdwn.ts';
import {
  CAPTURE_V1,
  readCapture,
  type Capture,
  type CaptureAuthor,
  type CaptureKind,
  type CaptureMessage,
} from './capture-payload.ts';
import { CaptureRefusedError } from './capture-refusal.ts';
import { oneLineText } from './capture-text.ts';

/**
 * Where a capture lands (ADR-0049): a folder of the Inbox, so it waits there
 * until it is clarified, like any capture (P30-01). `INBOX_DIRECTORY` is the
 * domain's, which this mapper cannot import.
 */
export const CAPTURES_FOLDER = 'Inbox/Captures';

export interface CaptureOptions {
  /** The IANA zone the times in the body are shown on. Left out: UTC. */
  readonly timeZone?: string;
  /**
   * The wiki link target of an author's Person note, or null for none. Left
   * out — n8n has no vault to look in — every author is written by name.
   */
  readonly personFor?: (author: CaptureAuthor) => string | null;
}

/** A capture as the file DFAI writes for it. */
export interface CaptureFile {
  /** `Inbox/Captures/<title>.md`. */
  readonly path: string;
  /** `Inbox/Captures/<title> (slack <hash>).md`: where it goes when another note holds `path`. */
  readonly collisionPath: string;
  readonly content: string;
  readonly kind: CaptureKind;
  readonly title: string;
  readonly provider: string;
  readonly externalId: string;
  readonly commitMessage: string;
}

/** A payload, read as capture/v1 and written as its file. Throws a `CaptureRefusedError` when refused. */
export function mapCapture(payload: unknown, options: CaptureOptions = {}): CaptureFile {
  return captureFile(readCapture(payload), options);
}

/**
 * A capture's file: frontmatter that says what it is and where it came from,
 * then the message, its thread and its attachments. The bytes are the
 * capture's and the options' alone — no clock, no randomness — so two Macs,
 * or n8n and the app, write the same file for the same message.
 */
export function captureFile(capture: Capture, options: CaptureOptions = {}): CaptureFile {
  const title = titleOf(capture);
  const writer = {
    capture,
    shownAt: clockIn(options.timeZone ?? 'UTC'),
    personFor: options.personFor ?? (() => null),
  };
  const content = `${frontmatter(capture, writer)}\n\n${body(writer).join('\n')}\n`;
  return {
    ...capturePaths(title, capture.externalId),
    content,
    kind: capture.kind,
    title,
    provider: capture.provider,
    externalId: capture.externalId,
    commitMessage: `Capture: ${title} (${capture.provider})`,
  };
}

interface FileWriter {
  readonly capture: Capture;
  readonly shownAt: (ts: string) => string;
  readonly personFor: (author: CaptureAuthor) => string | null;
}

/** The longest a title taken from a message runs, in characters, before it is cut at a word. */
const TAKEN_TITLE_LENGTH = 80;

/** The title asked for, else the message's first line, else who sent it. */
function titleOf(capture: Capture): string {
  if (capture.title !== null) return capture.title;
  const first = slackToPlain(capture.message.text, capture.users)
    .split('\n')
    .map(oneLineText)
    .find((line) => line !== '');
  return first === undefined
    ? `Slack message from ${capture.message.author.name}`
    : cutAtWord(first);
}

function cutAtWord(line: string): string {
  const characters = [...line];
  if (characters.length <= TAKEN_TITLE_LENGTH) return line;
  const cut = characters.slice(0, TAKEN_TITLE_LENGTH).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > TAKEN_TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function capturePaths(
  title: string,
  externalId: string,
): Pick<CaptureFile, 'path' | 'collisionPath'> {
  const stem = fileTitle(title) || 'Slack message';
  const suffix = ` (slack ${shortHash(`slack\n${externalId}`)})`;
  return {
    path: `${CAPTURES_FOLDER}/${fitStem(stem, '.md')}.md`,
    collisionPath: `${CAPTURES_FOLDER}/${fitStem(stem, `${suffix}.md`)}${suffix}.md`,
  };
}

/** A Slack ts as the instant it names, in milliseconds. */
function instantOf(ts: string): number {
  const [seconds = '0', micros = '0'] = ts.split('.');
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}

/** A reader of a ts as `YYYY-MM-DD HH:MM` on the zone's clock; refuses a zone that is not one. */
function clockIn(timeZone: string): (ts: string) => string {
  try {
    const clock = wallClockIn(timeZone);
    return (ts) => {
      const { day, time } = clock(instantOf(ts));
      return `${day} ${time.slice(0, 5)}`;
    };
  } catch (error) {
    if (error instanceof MeetingMappingError)
      throw new CaptureRefusedError([`timeZone: ${error.message}`]);
    throw error;
  }
}

/** A YAML scalar every reader takes as text: single-quoted, `'` doubled. */
const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** A Person's link target the file can hold: one that a `]`, `|`, `#` or `^` would not break. */
function personLink(writer: FileWriter, author: CaptureAuthor): string | null {
  const target = writer.personFor(author);
  return target === null || target === '' || /[[\]|#^\n]/.test(target) ? null : `[[${target}]]`;
}

function frontmatter(capture: Capture, writer: FileWriter): string {
  const { message, channel } = capture;
  return [
    '---',
    ...(capture.kind === 'task' ? ['type: task', 'status: inbox'] : []),
    `atlas_import: ${CAPTURE_V1}`,
    `provider: ${capture.provider}`,
    `external_id: ${quoted(capture.externalId)}`,
    `source: ${quoted(message.url)}`,
    `author: ${quoted(personLink(writer, message.author) ?? message.author.name)}`,
    ...(message.author.email === null ? [] : [`author_email: ${quoted(message.author.email)}`]),
    `channel: ${quoted(channel.name === null ? channel.id : `#${channel.name}`)}`,
    `sent_at: ${quoted(new Date(instantOf(message.ts)).toISOString())}`,
    '---',
  ].join('\n');
}

function body(writer: FileWriter): string[] {
  const { message, thread, attachments } = writer.capture;
  const lines = messageBlock(writer, message, `m${blockIdOf(message.ts)}`);
  if (thread.length > 0) {
    lines.push('', '## Thread');
    for (const reply of thread)
      lines.push('', ...messageBlock(writer, reply, `r${blockIdOf(reply.ts)}`));
  }
  if (attachments.length > 0) {
    lines.push('', '## Attachments', '');
    for (const { name, url } of attachments) lines.push(`- ${markdownLink(url, name)}`);
  }
  return lines;
}

/** A ts as a block id's tail: `1761600000.000100` is `1761600000-000100`, the same for every writer. */
const blockIdOf = (ts: string) => ts.replace('.', '-');

/**
 * One message as a quote: who sent it and when, a link back to it, and its
 * words; then its block id on a line of its own (ADR-0022), so each message
 * is citable as `[[Note#^r1761600300-000200]]`.
 */
function messageBlock(writer: FileWriter, message: CaptureMessage, id: string): string[] {
  const author = personLink(writer, message.author) ?? escapeMarkdown(message.author.name);
  const link = message.url === null ? '' : ` · ${markdownLink(message.url, 'Open in Slack')}`;
  const words = slackToMarkdown(message.text, writer.capture.users);
  const quote = [
    `**${author}** · ${writer.shownAt(message.ts)}${link}`,
    ...(words.length > 0 ? ['', ...words] : []),
  ];
  return [...quote.map((line) => (line === '' ? '>' : `> ${line}`)), '', `^${id}`];
}
