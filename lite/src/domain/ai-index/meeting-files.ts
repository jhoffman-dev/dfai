import type { VaultIndex } from '../index/index.ts';
import { splitWikiLinks } from '../links/index.ts';
import { isConflictCopyPath } from '../sync/index.ts';
import { fileNameOf, type VaultPath } from '../vault/index.ts';
import { lineSummary } from './note-line.ts';
import {
  INDEX_ROOT,
  byCode,
  cappedList,
  fileText,
  linkTo,
  truncated,
  type IndexFile,
} from './text.ts';

export const MEETINGS_FOLDER = 'Meetings';
export const UNDATED_MEETINGS = 'undated';

const MAX_PEOPLE = 8;
const MAX_ABOUT = 100;
const DATED_NAME = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?: (.*))?\.md$/;

/** A meeting note as the meeting index reads it. */
export interface MeetingEntry {
  readonly path: VaultPath;
  /** `YYYY-MM-DD` from the file name, or null when the name has none. */
  readonly date: string | null;
  readonly line: string;
}

/** A month the meetings index covers, for the README. */
export interface MeetingMonth {
  readonly month: string;
  readonly count: number;
  readonly file: string;
}

/** Whether a note is a meeting note: anything under `Meetings/`. */
export const isMeetingPath = (path: VaultPath): boolean => path.startsWith(`${MEETINGS_FOLDER}/`);

/** `_index/meetings/<YYYY>-<MM>.md`, and `undated.md` for meeting files whose name has no date. */
export function meetingFiles(
  index: VaultIndex,
  texts: ReadonlyMap<VaultPath, string>,
): { files: IndexFile[]; months: MeetingMonth[] } {
  const byMonth = new Map<string, MeetingEntry[]>();
  for (const path of index.paths().filter(isMeetingPath)) {
    const entry = meetingEntry(index, path, texts.get(path) ?? '');
    const month = entry.date === null ? UNDATED_MEETINGS : entry.date.slice(0, 7);
    const group = byMonth.get(month);
    if (group === undefined) byMonth.set(month, [entry]);
    else group.push(entry);
  }
  const files: IndexFile[] = [];
  const months: MeetingMonth[] = [];
  for (const month of [...byMonth.keys()].sort(byCode)) {
    const entries = (byMonth.get(month) as MeetingEntry[]).sort(byDateThenPath);
    const file = `${INDEX_ROOT}/meetings/${month}.md`;
    files.push({ path: file, text: monthText(month, entries) });
    months.push({ month, count: entries.length, file });
  }
  return { files, months };
}

function monthText(month: string, entries: readonly MeetingEntry[]): string {
  const dated = month !== UNDATED_MEETINGS;
  const heading = dated
    ? `# Meetings ${month} — ${entries.length}`
    : `# Meetings with no date in the file name — ${entries.length}`;
  const format = dated
    ? 'Line: date | title | with [[people]] | about … | ! conflict copy | first sentence | at path. Empty parts are left out; the path is Meetings/<YYYY>/<MM>/<date> <title>.md unless "at" gives it.'
    : 'Line: path | with [[people]] | about … | ! conflict copy | first sentence. Empty parts are left out.';
  return fileText([heading, format, ...entries.map(({ line }) => line)]);
}

function byDateThenPath(left: MeetingEntry, right: MeetingEntry): number {
  return byCode(left.date ?? '', right.date ?? '') || byCode(left.path, right.path);
}

function meetingEntry(index: VaultIndex, path: VaultPath, text: string): MeetingEntry {
  const match = DATED_NAME.exec(fileNameOf(path));
  const date = match === null ? null : `${match[1]}-${match[2]}-${match[3]}`;
  const title = match?.[4] ?? '';
  const parts = date === null ? [path] : [date];
  if (date !== null && title !== '') parts.push(title);
  const people = headerValue(text, 'With');
  if (people !== null) parts.push(`with ${withPart(people)}`);
  const about = headerValue(text, 'About');
  if (about !== null && about !== '') parts.push(`about ${truncated(about, MAX_ABOUT)}`);
  if (isConflictCopyPath(path)) parts.push('! conflict copy');
  const summary = lineSummary(index.summary(path));
  if (summary !== '') parts.push(summary);
  if (date !== null && path !== canonicalPath(date, fileNameOf(path))) parts.push(`at ${path}`);
  return { path, date, line: parts.join(' | ') };
}

/** Where the vault contract puts a meeting held on `date`. */
const canonicalPath = (date: string, fileName: string): string =>
  `${MEETINGS_FOLDER}/${date.slice(0, 4)}/${date.slice(5, 7)}/${fileName}`;

/** The value of a `- Key: value` header line, the first one in the note; null when there is none. */
export function headerValue(text: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*[-*+]\\s+${key}:\\s*(.*)$`, 'i');
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match !== null) return (match[1] ?? '').trim();
  }
  return null;
}

/** The people a `With:` line links, as links; the line as written when it links nobody. */
function withPart(value: string): string {
  const names: string[] = [];
  for (const piece of splitWikiLinks(value)) {
    if (piece.kind === 'wikiLink' && !names.includes(piece.target.trim())) {
      names.push(piece.target.trim());
    }
  }
  return names.length === 0
    ? truncated(value, MAX_ABOUT)
    : cappedList(names.map(linkTo), MAX_PEOPLE);
}
