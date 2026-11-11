/**
 * What a rule a note sets off has handled, kept apart from the entries that
 * say how (ADR-0028, "The handled ledger").
 *
 * A log keeps its last 100 entries, so it cannot be the rule's memory: a
 * meeting whose entry aged out would be asked about again, for ever. The
 * ledger is a compact list in the log's own note — a section a person can
 * read, written in the same write as the entry that changed it — of the
 * versions handled, by path, and the words a Claude step answered, each with
 * the instant it was recorded. It is pruned by age, count and bytes, never by
 * what else the log is made to hold.
 *
 * ```markdown
 * ## Handled so far
 * <!-- atlas:handled-ledger v1 -->
 *
 * DFAI keeps this list so the rule remembers ... Leave it as it is.
 *
 * - through `"2026-10-08T09:00:00"` `"5e6f7a8b"`
 * - records `2`
 * - vouches from `"2026-07-01T00:00:00.000Z"`
 * - handled `"Inbox/Meetings/Standup.md"` `"2026-10-08T09:00:00.000Z"`: `["1a2b3c4d"]`
 * - answered `"Inbox/Meetings/Standup.md"` `"2026-10-08T09:00:00.000Z"`: `["1a2b3c4d","meeting:larkspur:m-1042:transcript:9f8e"]`
 * - stored `"meeting:larkspur:m-1042:transcript:7c6d"` `"2026-10-08T09:05:00.000Z"`: `["{\"items\":[]}"]` `["3c4d5e6f"]`
 * ```
 *
 * The comment on the line after the heading is what makes a section the
 * ledger: a section a person titled "Handled so far" is theirs, and is never
 * read or replaced. It names the format's version, so a later format is
 * recognised as one this reader does not read.
 *
 * - `through` is the last log entry the ledger had folded in (its wall-clock
 *   heading time, and a digest of its text). Entries after it were written by
 *   a DFAI that did not know the ledger, and are laid over it.
 * - `records` is how many `handled` and `answered` lines were written, so a
 *   line lost is told from a line never there.
 * - `vouches from` is set once something was forgotten: the ledger cannot say
 *   whether a note last written before it was handled. It is a real instant.
 * - A time in a `handled` or `answered` line is a real UTC instant from the
 *   clock the use-case was handed, so it is comparable with a file's time.
 * - A `stored` line is a model's answer about a meeting's words, kept by a
 *   step making proposals (ADR-0036, "The model's answer is kept and reused";
 *   any such step since #793) when a
 *   run that asked could not finish, so its retry asks nothing again. It is
 *   no record of what was handled: forgetting one only costs an ask.
 *
 * An answered line holds more than one key for the version: its whole-file
 * digest first, then any a rule's schema names it by. A schema key must carry
 * the note's identity — `meeting:<provider>:<external_id>:transcript:<digest>` —
 * never a bare body digest, which two notes can share; {@link isSchemaKey}
 * is the minimal shape that is kept.
 */

import { digestOf } from '../sources/merge.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { code, JSON_SPAN } from './log-spans.ts';
import { splitSections, utf8Length } from './log-sections.ts';
import { formatLogEntry, type LogEntry } from './run-log.ts';
import { localTimeMs, type LocalTime } from './schedule.ts';

type Run = Extract<LogEntry, { kind: 'run' }>;

/** The last log entry a ledger has folded in: when its heading says it ran, and a digest of its text. */
export interface LedgerMark {
  readonly at: LocalTime;
  readonly digest: string;
}

/** The versions handled at one path, newest last, and when it last was. */
export interface PathRecord {
  readonly at: number;
  readonly digests: readonly string[];
}

/** Words a Claude step answered: where, when, and the keys they are known by (the digest first). */
export interface AnsweredRecord {
  readonly at: number;
  readonly path: VaultPath;
  readonly keys: readonly string[];
}

/** A model's answers about a meeting's words, one per ask, kept until a run that read them finishes. */
export interface StoredAnswer {
  /** The words answered, as the schema knows them: `meeting:<provider>:<id>:transcript:<digest>`. */
  readonly key: string;
  readonly at: number;
  /** Each ask's answer, as the model gave it, in the order asked. */
  readonly answers: readonly string[];
  /**
   * What each ask showed, one per answer (`askedTurnsDigest`): an answer is
   * reused only against the same turns it answered.
   */
  readonly parts: readonly string[];
}

/** A stored answer before the ledger dates it. */
export type StoredAnswerDraft = Omit<StoredAnswer, 'at'>;

export interface HandledLedger {
  /** Milliseconds since the epoch; null while nothing was ever forgotten. */
  readonly vouchesFrom: number | null;
  readonly paths: ReadonlyMap<string, PathRecord>;
  readonly answered: readonly AnsweredRecord[];
  readonly stored: readonly StoredAnswer[];
  /** The last entry folded in; null for a ledger not yet written. */
  readonly through: LedgerMark | null;
  /** Whether what was read did not add up (a line lost or unreadable, two ledgers, a version unknown). Never written. */
  readonly damaged: boolean;
}

/** How long a record is kept, the most records a ledger holds, and the most bytes its section takes. */
export const LEDGER_MAX_AGE_DAYS = 90;
export const MAX_LEDGER_RECORDS = 2000;
export const LEDGER_MAX_BYTES = 96 * 1024;
/** The versions of one note remembered: older ones come back only by reverting to them. */
export const MAX_DIGESTS_PER_PATH = 5;
/** Schema keys kept for one answer, and the longest one. */
const MAX_KEYS_PER_ANSWER = 8;
const MAX_KEY_LENGTH = 256;
/**
 * The most stored answers a ledger keeps, and the most bytes they take: they
 * wait only for a retry, so they are few, and they never crowd out what was
 * handled.
 */
export const MAX_STORED_ANSWERS = 20;
export const STORED_ANSWERS_MAX_BYTES = 32 * 1024;
const DAY_MS = 86_400_000;
/** The furthest ahead of UTC a wall clock can be (UTC+14). */
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;

export const LEDGER_HEADING = '## Handled so far';
export const LEDGER_VERSION = 1;
const MARKER = /^<!-- atlas:handled-ledger v(\d+) -->$/;
const LEDGER_MARKER = `<!-- atlas:handled-ledger v${LEDGER_VERSION} -->`;
// Says "Atlas", the app's name before DFAI (ADR-0042): the ledger is rewritten
// whole, so a Mac on each name would otherwise trade the words back and forth.
const LEDGER_NOTE =
  'Atlas keeps this list so the rule remembers what it has handled after old entries leave this log. Leave it as it is.';

export const emptyLedger = (): HandledLedger => ({
  vouchesFrom: null,
  paths: new Map(),
  answered: [],
  stored: [],
  through: null,
  damaged: false,
});

/**
 * Whether a key from a rule's schema may be matched on: non-empty on both
 * sides of a colon, and not long. It must name the thing answered — the
 * note's identity, in the form `meeting:<provider>:<external_id>:transcript:<digest>`
 * — because a key is taken as the same note wherever its file now is.
 */
export function isSchemaKey(key: string): boolean {
  const colon = key.indexOf(':');
  return colon > 0 && colon < key.length - 1 && key.length <= MAX_KEY_LENGTH;
}

/**
 * The earliest instant a wall-clock time can be, for an entry written before
 * the ledger kept real ones: with no zone to read it by, it is taken as the
 * furthest-ahead zone's reading, so a floor derived from it is never later
 * than the truth (a later one would hide a meeting that was never asked).
 */
const earliestInstant = (local: LocalTime): number =>
  (localTimeMs(local) ?? MAX_UTC_OFFSET_MS) - MAX_UTC_OFFSET_MS;

/**
 * The ledger once a run has happened at `at`: its versions handled, notes gone
 * and notes it archived forgotten, and notes moved remembered where they are
 * now — each with what was handled where it was, and the version it moved as.
 */
export function recordRun(ledger: HandledLedger, entry: Run, at: number): HandledLedger {
  const paths = new Map(ledger.paths);
  let answered = [...ledger.answered];
  let stored = ledger.stored;
  for (const path of entry.went ?? []) paths.delete(path);
  for (const { from, path, digest } of entry.moved ?? []) {
    const before = ledger.paths.get(from)?.digests.filter((each) => each !== digest) ?? [];
    paths.set(path, { at, digests: [...before, digest].slice(-MAX_DIGESTS_PER_PATH) });
  }
  for (const { path, digest, wrote, keys = [] } of entry.versions ?? []) {
    const before = paths.get(path)?.digests.filter((each) => each !== digest) ?? [];
    paths.set(path, { at, digests: [...before, digest].slice(-MAX_DIGESTS_PER_PATH) });
    if (entry.claude !== undefined && !wrote) {
      const schemaKeys = keys.filter(isSchemaKey).slice(0, MAX_KEYS_PER_ANSWER);
      answered = answered.filter((each) => !(each.path === path && each.keys[0] === digest));
      answered.push({ at, path, keys: [digest, ...schemaKeys] });
      // Words answered are never asked about again: their stored answer has done its work.
      stored = stored.filter((each) => !schemaKeys.includes(each.key));
    }
  }
  for (const action of entry.done) if (action.kind === 'archived') paths.delete(action.from);
  return { ...ledger, paths, answered, stored };
}

/**
 * The ledger keeping the answers a run read and could not finish with, dated
 * `at`: each replaces one stored for the same words. One whose key is not a
 * schema key, or that has no answers, is not kept.
 */
export function recordStored(
  ledger: HandledLedger,
  drafts: readonly StoredAnswerDraft[],
  at: number,
): HandledLedger {
  const kept = drafts.filter(
    ({ key, answers, parts }) =>
      isSchemaKey(key) && answers.length > 0 && parts.length === answers.length,
  );
  if (kept.length === 0) return ledger;
  const keys = new Set(kept.map(({ key }) => key));
  return {
    ...ledger,
    stored: [
      ...ledger.stored.filter(({ key }) => !keys.has(key)),
      ...kept.map(({ key, answers, parts }) => ({
        key,
        at,
        answers: [...answers],
        parts: [...parts],
      })),
    ],
  };
}

/** The answers stored for the words a key names; null when none are. */
export function storedAnswerFor(ledger: HandledLedger | null, key: string): StoredAnswer | null {
  return ledger?.stored.find((each) => each.key === key) ?? null;
}

/** What identifies a log entry as the last one a ledger folded in. */
export const markOf = (entry: LogEntry): LedgerMark => ({
  at: entry.at,
  digest: digestOf(formatLogEntry(entry)),
});

/**
 * The ledger a log without one implies: its entries, once. A log already full
 * may have dropped entries before this, so it vouches only from its oldest.
 */
export function ledgerFromEntries(entries: readonly LogEntry[], keep: number): HandledLedger {
  let ledger = emptyLedger();
  for (const entry of entries) {
    if (entry.kind === 'run') ledger = recordRun(ledger, entry, earliestInstant(entry.at));
  }
  const oldest = entries[0];
  const full = entries.length >= keep && oldest !== undefined;
  return full ? { ...ledger, vouchesFrom: earliestInstant(oldest.at) } : ledger;
}

/**
 * The entries a ledger has not folded in: those after the one it names. An
 * DFAI that does not know the ledger appends to the log and drops from its
 * front, so the named entry may be gone, and then those written after its
 * time are the newer. A ledger that did not add up folds in nothing it can
 * trust, and every entry is laid over it.
 */
function entriesAfterMark(
  ledger: HandledLedger,
  entries: readonly LogEntry[],
): readonly LogEntry[] {
  const { through } = ledger;
  if (ledger.damaged || through === null) return entries;
  const found = entries.findLastIndex(
    (entry) => entry.at === through.at && markOf(entry).digest === through.digest,
  );
  // Wall-clock times written as `YYYY-MM-DDTHH:MM:SS` sort as text.
  return found === -1 ? entries.filter((entry) => entry.at > through.at) : entries.slice(found + 1);
}

/** The ledger with the runs it has not folded in laid over it, oldest first; what it let go stays gone. */
export function layOver(ledger: HandledLedger, entries: readonly LogEntry[]): HandledLedger {
  let laid = ledger;
  for (const entry of entriesAfterMark(ledger, entries)) {
    if (entry.kind === 'run') laid = recordRun(laid, entry, earliestInstant(entry.at));
  }
  return laid;
}

/**
 * What a rule remembers now: its ledger with the entries written after it
 * laid over — a run from a DFAI that did not know the ledger (a second Mac,
 * a rollback) is not forgotten — or, for a log with none, what its entries
 * imply. A ledger that did not add up vouches for nothing until DFAI next
 * writes the log, which sets the floor to that moment.
 */
export function ledgerNow(
  ledger: HandledLedger | null,
  entries: readonly LogEntry[],
  keep: number,
): HandledLedger {
  if (ledger === null) return ledgerFromEntries(entries, keep);
  const laid = layOver(ledger, entries);
  return ledger.damaged ? { ...laid, vouchesFrom: Number.POSITIVE_INFINITY } : laid;
}

type Forgettable =
  | { readonly at: number; readonly size: number; readonly path: string }
  | { readonly at: number; readonly size: number; readonly answered: AnsweredRecord };

/**
 * The ledger without what is older than {@link LEDGER_MAX_AGE_DAYS} by
 * `now`, or past the count, or past the bytes, oldest first; and the floor
 * that leaves. `now` is the clock's, never a time an entry says: a stamp
 * later than the clock cannot age a record, nor floor catch-up past it.
 */
export function pruneLedger(
  ledger: HandledLedger,
  now: number,
  {
    maxRecords = MAX_LEDGER_RECORDS,
    maxBytes = LEDGER_MAX_BYTES,
  }: { maxRecords?: number; maxBytes?: number } = {},
): HandledLedger {
  return pruneHandled(pruneStored(ledger, now), now, { maxRecords, maxBytes });
}

/**
 * The stored answers within their own limits, oldest gone first: by age, by
 * count and by bytes. Forgetting one moves no floor: it was never a record of
 * what was handled.
 */
function pruneStored(ledger: HandledLedger, now: number): HandledLedger {
  const cutoff = now - LEDGER_MAX_AGE_DAYS * DAY_MS;
  const newest = [...ledger.stored]
    .filter((each) => each.at >= cutoff)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_STORED_ANSWERS);
  const kept: StoredAnswer[] = [];
  let room = STORED_ANSWERS_MAX_BYTES;
  for (const each of newest) {
    const size = utf8Length(storedLine(each)) + 1;
    // One too big to keep is left out; the older ones that fit stay.
    if (size > room) continue;
    room -= size;
    kept.push(each);
  }
  return kept.length === ledger.stored.length ? ledger : { ...ledger, stored: kept.reverse() };
}

function pruneHandled(
  ledger: HandledLedger,
  now: number,
  { maxRecords, maxBytes }: { maxRecords: number; maxBytes: number },
): HandledLedger {
  const records: Forgettable[] = [
    ...[...ledger.paths].map(([path, record]) => ({
      at: record.at,
      size: utf8Length(handledLine(path, record)) + 1,
      path,
    })),
    ...ledger.answered.map((answered) => ({
      at: answered.at,
      size: utf8Length(answeredLine(answered)) + 1,
      answered,
    })),
  ].sort((a, b) => a.at - b.at);
  const cutoff = now - LEDGER_MAX_AGE_DAYS * DAY_MS;
  const tooOld = records.filter((record) => record.at < cutoff).length;
  const base = Math.max(tooOld, records.length - maxRecords);
  const forgetting = Math.max(base, overBytes(ledger, records, maxBytes, base));
  if (forgetting === 0) return ledger;
  const forgotten = records.slice(0, forgetting);
  const paths = new Map(ledger.paths);
  const answered = new Set(ledger.answered);
  for (const record of forgotten) {
    if ('path' in record) paths.delete(record.path);
    else answered.delete(record.answered);
  }
  // Nothing last written before the newest thing forgotten can be vouched for.
  const floor = Math.min(now, Math.max(...forgotten.map((record) => record.at)));
  return {
    ...ledger,
    vouchesFrom: Math.max(ledger.vouchesFrom ?? floor, floor),
    paths,
    answered: [...answered],
  };
}

/** How many of the oldest records must go for the section to fit, counting the `vouches from` line it would then hold. */
function overBytes(
  ledger: HandledLedger,
  records: readonly Forgettable[],
  maxBytes: number,
  alreadyForgetting: number,
): number {
  // The stored answers stay whatever is forgotten: they are part of what is fixed, and of the count.
  const stored = ledger.stored.length;
  const fixed = (count: number, vouches: boolean): number =>
    utf8Length(
      formatLedger({ ...ledger, paths: new Map(), answered: [], vouchesFrom: vouches ? 0 : null }),
    ) +
    String(count + stored).length -
    String(stored).length;
  const room = (vouches: boolean): number => {
    let left = maxBytes - fixed(records.length, vouches);
    let keep = records.length;
    while (keep > 0 && left >= records[keep - 1]!.size) {
      left -= records[keep - 1]!.size;
      keep -= 1;
    }
    return keep;
  };
  const withoutFloor = room(ledger.vouchesFrom !== null);
  if (withoutFloor === 0 && alreadyForgetting === 0) return 0;
  return room(true);
}

const instant = (at: number): string => new Date(at).toISOString();
const handledLine = (path: string, { at, digests }: PathRecord): string =>
  `- handled ${code(path)} ${code(instant(at))}: ${code(digests)}`;
const answeredLine = ({ path, at, keys }: AnsweredRecord): string =>
  `- answered ${code(path)} ${code(instant(at))}: ${code(keys)}`;
const storedLine = ({ key, at, answers, parts }: StoredAnswer): string =>
  `- stored ${code(key)} ${code(instant(at))}: ${code(answers)} ${code(parts)}`;

/** The section the log holds, which {@link readHandledLedger} reads back. */
export function formatLedger(ledger: HandledLedger): string {
  const records = ledger.paths.size + ledger.answered.length + ledger.stored.length;
  const lines = [
    ...(ledger.through === null
      ? []
      : [`- through ${code(ledger.through.at)} ${code(ledger.through.digest)}`]),
    `- records ${code(records)}`,
    // Only a finite floor is an instant to write; DFAI sets one before it writes.
    ...(ledger.vouchesFrom === null || !Number.isFinite(ledger.vouchesFrom)
      ? []
      : [`- vouches from ${code(instant(ledger.vouchesFrom))}`]),
    ...[...ledger.paths]
      .sort(([, a], [, b]) => a.at - b.at)
      .map(([path, r]) => handledLine(path, r)),
    ...[...ledger.answered].sort((a, b) => a.at - b.at).map(answeredLine),
    ...[...ledger.stored].sort((a, b) => a.at - b.at).map(storedLine),
  ];
  return `${LEDGER_HEADING}\n${LEDGER_MARKER}\n\n${LEDGER_NOTE}\n\n${lines.join('\n')}\n`;
}

export const isEmptyLedger = (ledger: HandledLedger): boolean =>
  ledger.vouchesFrom === null &&
  ledger.paths.size === 0 &&
  ledger.answered.length === 0 &&
  ledger.stored.length === 0;

const THROUGH_LINE = new RegExp(`^- through ${JSON_SPAN} ${JSON_SPAN}$`);
const RECORDS_LINE = new RegExp(`^- records ${JSON_SPAN}$`);
const VOUCHES_LINE = new RegExp(`^- vouches from ${JSON_SPAN}$`);
const HANDLED_LINE = new RegExp(`^- handled ${JSON_SPAN} ${JSON_SPAN}: ${JSON_SPAN}$`);
const ANSWERED_LINE = new RegExp(`^- answered ${JSON_SPAN} ${JSON_SPAN}: ${JSON_SPAN}$`);
const STORED_LINE = new RegExp(`^- stored ${JSON_SPAN} ${JSON_SPAN}: ${JSON_SPAN} ${JSON_SPAN}$`);

/**
 * The ledger a section holds. A line that does not read — a person may have
 * edited it — is left out, and the ledger is {@link HandledLedger.damaged},
 * as it is when the records written do not number what the section says.
 */
export function parseLedger(section: string): HandledLedger {
  let vouchesFrom: number | null = null;
  let through: LedgerMark | null = null;
  let declared: number | null = null;
  let read = 0;
  let damaged = false;
  const paths = new Map<string, PathRecord>();
  const answered: AnsweredRecord[] = [];
  const stored: StoredAnswer[] = [];
  for (const line of section.split('\n').map((each) => each.trim())) {
    if (!line.startsWith('- ')) continue;
    try {
      const matched = readLine(line);
      if (matched.kind === 'through') through = matched.mark;
      else if (matched.kind === 'records') declared = matched.count;
      else if (matched.kind === 'vouches') vouchesFrom = matched.at;
      else if (matched.kind === 'handled') {
        paths.set(matched.path, matched.record);
        read += 1;
      } else if (matched.kind === 'stored') {
        stored.push(matched.record);
        read += 1;
      } else {
        answered.push(matched.record);
        read += 1;
      }
    } catch {
      // A line edited into something that does not read is left out, and the ledger says it is damaged.
      damaged = true;
    }
  }
  return {
    vouchesFrom,
    paths,
    answered,
    stored,
    through,
    damaged: damaged || through === null || declared !== read,
  };
}

type ReadLine =
  | { kind: 'through'; mark: LedgerMark }
  | { kind: 'records'; count: number }
  | { kind: 'vouches'; at: number }
  | { kind: 'handled'; path: string; record: PathRecord }
  | { kind: 'answered'; record: AnsweredRecord }
  | { kind: 'stored'; record: StoredAnswer };

function readLine(line: string): ReadLine {
  const through = THROUGH_LINE.exec(line);
  if (through !== null) {
    return { kind: 'through', mark: { at: localTimeOf(through[1]!), digest: textOf(through[2]!) } };
  }
  const records = RECORDS_LINE.exec(line);
  if (records !== null) return { kind: 'records', count: countOf(records[1]!) };
  const vouches = VOUCHES_LINE.exec(line);
  if (vouches !== null) return { kind: 'vouches', at: timeOf(vouches[1]!) };
  const handled = HANDLED_LINE.exec(line);
  if (handled !== null) {
    const path = pathOf(handled[1]!);
    return {
      kind: 'handled',
      path,
      record: { at: timeOf(handled[2]!), digests: stringsOf(handled[3]!) },
    };
  }
  const answer = ANSWERED_LINE.exec(line);
  if (answer !== null) {
    const keys = stringsOf(answer[3]!);
    if (keys.length === 0) throw new Error('no keys');
    const record = {
      path: createVaultPath(pathOf(answer[1]!)),
      at: timeOf(answer[2]!),
      keys: [keys[0]!, ...keys.slice(1).filter(isSchemaKey)],
    };
    return { kind: 'answered', record };
  }
  const kept = STORED_LINE.exec(line);
  if (kept !== null) {
    const key = textOf(kept[1]!);
    const answers = stringsOf(kept[3]!);
    const parts = stringsOf(kept[4]!);
    if (!isSchemaKey(key) || answers.length === 0 || parts.length !== answers.length) {
      throw new Error('not a stored answer');
    }
    return { kind: 'stored', record: { key, at: timeOf(kept[2]!), answers, parts } };
  }
  throw new Error('not a ledger line');
}

function textOf(json: string): string {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== 'string') throw new Error('not text');
  return value;
}

function localTimeOf(json: string): LocalTime {
  const value = textOf(json);
  if (localTimeMs(value) === null) throw new Error('not a wall-clock time');
  return value;
}

function countOf(json: string): number {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('not a count');
  }
  return value;
}

function pathOf(json: string): string {
  return createVaultPath(textOf(json));
}

function timeOf(json: string): number {
  const at = Date.parse(textOf(json));
  if (Number.isNaN(at)) throw new Error('not a time');
  return at;
}

function stringsOf(json: string): string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value) || !value.every((each) => typeof each === 'string')) {
    throw new Error('not a list of words');
  }
  return value as string[];
}

/** The oldest of the marks, or null if any is missing: the entries after it are the ones to lay over. */
function earliestMark(marks: readonly (LedgerMark | null)[]): LedgerMark | null {
  if (marks.some((mark) => mark === null)) return null;
  return (marks as LedgerMark[]).reduce((a, b) => (b.at < a.at ? b : a));
}

/** Two ledgers that should have been one, as one: it forgets nothing either knew, and is damaged. */
function mergeLedgers(ledgers: readonly HandledLedger[]): HandledLedger {
  const floors = ledgers.map((ledger) => ledger.vouchesFrom).filter((at) => at !== null);
  const paths = new Map<string, PathRecord>();
  const answered = new Map<string, AnsweredRecord>();
  const stored = new Map<string, StoredAnswer>();
  for (const ledger of ledgers) {
    for (const [path, record] of ledger.paths) {
      const other = paths.get(path);
      if (other === undefined) paths.set(path, record);
      else {
        const [older, newer] = other.at <= record.at ? [other, record] : [record, other];
        const digests = [
          ...older.digests.filter((d) => !newer.digests.includes(d)),
          ...newer.digests,
        ];
        paths.set(path, { at: newer.at, digests: digests.slice(-MAX_DIGESTS_PER_PATH) });
      }
    }
    for (const record of ledger.answered) answered.set(`${record.path}\n${record.keys[0]}`, record);
    for (const record of ledger.stored) {
      const other = stored.get(record.key);
      if (other === undefined || other.at < record.at) stored.set(record.key, record);
    }
  }
  return {
    vouchesFrom: floors.length === 0 ? null : Math.max(...floors),
    paths,
    answered: [...answered.values()],
    stored: [...stored.values()],
    through: earliestMark(ledgers.map((ledger) => ledger.through)),
    damaged: true,
  };
}

/** Where the ledger sections are among a log's sections, and the ledger they hold; null when there is none. */
export interface LocatedLedger {
  readonly at: readonly number[];
  readonly ledger: HandledLedger | null;
}

/**
 * The one place a ledger is found: a section whose heading is at the start
 * of its line and whose next line is the marker DFAI writes. A section
 * titled the same without it is a person's own, and is not here. A marker of
 * another version is a ledger this reader cannot read; two ledgers are
 * merged. Both are damaged, so the next write mends them.
 */
export function locateLedger(sections: readonly string[]): LocatedLedger {
  const found = sections.flatMap((section, at) => {
    const [heading = '', marker = ''] = section.split('\n');
    const version = MARKER.exec(marker.trimEnd());
    return heading.trimEnd() === LEDGER_HEADING && version !== null
      ? [
          {
            at,
            ledger: Number(version[1]) === LEDGER_VERSION ? parseLedger(section) : unreadable(),
          },
        ]
      : [];
  });
  if (found.length === 0) return { at: [], ledger: null };
  const ledgers = found.map((each) => each.ledger);
  return {
    at: found.map((each) => each.at),
    ledger: ledgers.length === 1 ? ledgers[0]! : mergeLedgers(ledgers),
  };
}

const unreadable = (): HandledLedger => ({ ...emptyLedger(), damaged: true });

/** The ledger a log's text holds; null when it holds none (a log from before the ledger). */
export function readHandledLedger(text: string | null): HandledLedger | null {
  return text === null ? null : locateLedger(splitSections(text).sections).ledger;
}
