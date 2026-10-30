import { fileTitle, fitStem } from '../../meetings/mapping/meeting-file-name.ts';
import { MeetingMappingError } from '../../meetings/mapping/meeting-mapping-error.ts';
import { wallClockIn } from '../../meetings/mapping/meeting-when.ts';
import { linkifyPhrasing } from './capture-linkify.ts';
import { slackToBlocks, slackToPlain, wordsToPhrasing } from './capture-mrkdwn.ts';
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
import {
  blockquote,
  bulletList,
  heading,
  link,
  paragraph,
  text,
  type MdBlock,
  type MdPhrasing,
  type WriteMarkdown,
} from './capture-tree.ts';

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
  /**
   * What writes the body's tree as markdown, a block at a time: the editor's
   * own serializer, with its settings (the adapters' `writeCaptureMarkdown`;
   * in n8n, the same bundled into the Code node).
   */
  readonly writeMarkdown: WriteMarkdown;
}

/** A capture as the file DFAI writes for it. */
export interface CaptureFile {
  /**
   * `Inbox/Captures/<title> (slack <hash>).md`. The title is for reading; the
   * hash of the message's key is what finds it, whatever title it was given.
   */
  readonly path: string;
  /** ` (slack <hash>).md`: how this message's file name ends, numbered (`… <hash> 2).md`) after a clash. */
  readonly keyEnding: string;
  readonly content: string;
  readonly kind: CaptureKind;
  readonly title: string;
  readonly provider: string;
  readonly externalId: string;
  readonly commitMessage: string;
}

/** A payload, read as capture/v1 and written as its file. Throws a `CaptureRefusedError` when refused. */
export function mapCapture(payload: unknown, options: CaptureOptions): CaptureFile {
  return captureFile(readCapture(payload), options);
}

/**
 * A capture's file: frontmatter that says what it is and where it came from,
 * then the message, its thread and its attachments. The bytes are the
 * capture's and the options' alone — no clock, no randomness — so writers
 * that agree on the zone and the Person links write the same file for the
 * same message; the path depends on neither, so one that does not agree
 * still finds the first (ADR-0049).
 */
export function captureFile(capture: Capture, options: CaptureOptions): CaptureFile {
  const title = titleOf(capture);
  const writer = {
    capture,
    shownAt: clockIn(options.timeZone ?? 'UTC'),
    personFor: options.personFor ?? (() => null),
  };
  const content = `${frontmatter(capture, writer)}\n\n${body(writer, options.writeMarkdown)}\n`;
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

/**
 * Where a capture is written: its title, then its key's hash. Two captures
 * of one message sent with different titles — n8n's from the first line, a
 * pasted link's as typed, an edited message's new first line — share the
 * ending, so the second finds the first by it while the index lags (review
 * of PR #615).
 */
function capturePaths(title: string, externalId: string): Pick<CaptureFile, 'path' | 'keyEnding'> {
  const keyEnding = ` (slack ${keyHash(`slack\n${externalId}`)}).md`;
  // Room for a number after the hash too, so a numbered path is never longer than a name may be.
  const fitted = fitStem(fileTitle(title), keyEnding.replace(').md', ' 99).md'));
  // A title too long for even one of its characters, or none, leaves nothing: it is never a name.
  const stem = fitted === '' ? 'Slack message' : fitted;
  return { path: `${CAPTURES_FOLDER}/${stem}${keyEnding}`, keyEnding };
}

/** 32-bit FNV-1a over the text's UTF-16 code units, from `basis`, as 8 hex digits. */
function fnv1a(text: string, basis: number): string {
  let hash = basis;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 64 bits of the key, as 16 hex digits: FNV-1a from two bases, one over the
 * key and one over it backwards. 32 bits alone gave two messages 71 seconds
 * apart in one channel the same name (attack on PR #615). Not for security;
 * pure arithmetic, so every engine answers alike.
 */
function keyHash(key: string): string {
  return `${fnv1a(key, 0x811c9dc5)}${fnv1a([...key].reverse().join(''), 0x050c5d1f)}`;
}

/** The path of `file` numbered `count` (2 and on): where it goes when another message's note holds its own. */
export function numberedCapturePath(
  file: Pick<CaptureFile, 'path' | 'keyEnding'>,
  count: number,
): string {
  const ending = file.keyEnding.replace(').md', ` ${count}).md`);
  return `${file.path.slice(0, -file.keyEnding.length)}${ending}`;
}

/** Whether a file name is one of this key's: its ending, numbered or not, in any case. */
export function isNamedForKey(name: string, keyEnding: string): boolean {
  const base = keyEnding.slice(0, -').md'.length).toLowerCase();
  const folded = name.toLowerCase();
  if (folded.endsWith(keyEnding.toLowerCase())) return true;
  const at = folded.lastIndexOf(`${base} `);
  return at !== -1 && /^ \d+\)\.md$/.test(folded.slice(at + base.length));
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

/**
 * A sender's words as a frontmatter value: brackets made parentheses, since
 * the index reads `[[x]]` anywhere in a property as a relation, and a Slack
 * name of `[[Mara Quill]]` would link a person no address matched.
 */
const unlinked = (text: string) => text.replace(/\[/g, '(').replace(/\]/g, ')');

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
    `author: ${quoted(personLink(writer, message.author) ?? unlinked(message.author.name))}`,
    ...(message.author.email === null ? [] : [`author_email: ${quoted(message.author.email)}`]),
    `channel: ${quoted(channel.name === null ? channel.id : `#${unlinked(channel.name)}`)}`,
    `sent_at: ${quoted(new Date(instantOf(message.ts)).toISOString())}`,
    '---',
  ].join('\n');
}

/** A block of the body, and the block id written on the line after it, if any. */
interface BodyBlock {
  readonly block: MdBlock;
  readonly id?: string;
}

/**
 * The body: each block written alone by `writeMarkdown`, as the editor writes
 * a block, with its id's line after it as the editor writes one (ADR-0022),
 * the blocks a blank line apart.
 */
function body(writer: FileWriter, writeMarkdown: WriteMarkdown): string {
  return bodyBlocks(writer)
    .map(({ block, id }) => {
      const written = writeMarkdown({ type: 'root', children: [block] });
      return id === undefined ? written : `${written}\n\n^${id}`;
    })
    .join('\n\n');
}

function bodyBlocks(writer: FileWriter): BodyBlock[] {
  const { message, thread, attachments } = writer.capture;
  const blocks: BodyBlock[] = [messageBlock(writer, message, `m${blockIdOf(message.ts)}`)];
  if (thread.length > 0) {
    blocks.push({ block: heading('Thread') });
    for (const reply of thread) blocks.push(messageBlock(writer, reply, `r${blockIdOf(reply.ts)}`));
  }
  if (attachments.length > 0) {
    blocks.push({ block: heading('Attachments') });
    blocks.push({ block: bulletList(attachments.map(({ name, url }) => [link(url, name)])) });
  }
  return blocks;
}

/** A ts as a block id's tail: `1761600000.000100` is `1761600000-000100`, the same for every writer. */
const blockIdOf = (ts: string) => ts.replace('.', '-');

/**
 * One message as a quote: who sent it and when, a link back to it, and its
 * words; then its block id (ADR-0022), so each message is citable as
 * `[[Note#^r1761600300-000200]]`.
 */
function messageBlock(writer: FileWriter, message: CaptureMessage, id: string): BodyBlock {
  const person = personLink(writer, message.author);
  const author: MdPhrasing[] =
    person === null ? wordsToPhrasing(message.author.name) : [{ type: 'wikiLink', value: person }];
  const header = linkifyPhrasing([
    { type: 'strong', children: author },
    text(` · ${writer.shownAt(message.ts)}`),
    ...(message.url === null ? [] : [text(' · '), link(message.url, 'Open in Slack')]),
  ]);
  const words = slackToBlocks(message.text, writer.capture.users);
  return { block: blockquote([paragraph(header), ...words]), id };
}
