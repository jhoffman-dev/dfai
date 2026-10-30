import { emailKey } from './meeting-email-key.ts';
import { MeetingMappingError, oneLine } from './meeting-mapping-error.ts';

/** One attendee as the contract writes it: `{ name, email?, group? }`. */
export interface Attendee {
  readonly name: string;
  readonly email?: string;
  readonly group?: true;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;
/** Punctuation a list leaves after an address (`ann@example.com,`), never part of it. */
const TRAILING_PUNCTUATION = /[,;.]+$/;
const BULLET = /^\s*[-*+]\s+/;
/** `[text](mailto:address)`, as Notion and email bodies write an address. */
const MAIL_LINK = /\[[^\]]*\]\(mailto:([^)\s]+)\)/gi;
/** `Name — email`, `Name – email`, `Name - email`. */
const DASHED = /^(.*?)\s+[—–-]\s+(\S+@\S+)$/;
/** `Name <email>` or `Name (email)`. */
const BRACKETED = /^(.*?)\s*[<(]\s*(\S+@[^\s>)]+)\s*[>)]$/;
/**
 * An address's local part that names a list rather than a person: a group
 * word on its own (`staff@`) or joined by `-` or `_` (`platform-team@`,
 * `all_hands@`). A dot joins a person's names (`dana.list@`), and a display
 * name is never read (`Staff Sergeant Rivera` is a person). A group stays an
 * attendee but must never become a Person (ADR-0027).
 */
const GROUP_LOCAL_PART =
  /(^|[_-])(team|group|all|everyone|list|staff|crew|squad|dept|department)($|[_-])/i;

const localPart = (email: string) => email.slice(0, email.indexOf('@'));

function isGroup(email: string | undefined, groupAddresses: Set<string>): boolean {
  if (email === undefined) return false;
  return groupAddresses.has(emailKey(email)) || GROUP_LOCAL_PART.test(localPart(email));
}

/** An attendee as read, and whether a display name was given (not made from the address). */
interface Read {
  readonly attendee: Attendee;
  readonly named: boolean;
}

function attendee(
  rawName: string,
  rawEmail: string,
  { explicitGroup, groupAddresses }: { explicitGroup: boolean; groupAddresses: Set<string> },
): Read | null {
  const written = oneLine(rawName.replace(/\\(.)/g, '$1'));
  const asAddress = (text: string) =>
    text
      .trim()
      .replace(/^mailto:/i, '')
      .replace(TRAILING_PUNCTUATION, '');
  // An address written as the display name is no name: it is named as a bare address is.
  const nameIsAddress = EMAIL.test(asAddress(written));
  const candidate = asAddress(rawEmail) || (nameIsAddress ? asAddress(written) : '');
  const email = EMAIL.test(candidate) ? candidate : undefined;
  const displayName = nameIsAddress ? '' : written;
  const name = displayName || (email && localPart(email)) || '';
  if (name === '') return null;
  const group = explicitGroup || isGroup(email, groupAddresses);
  return {
    attendee: { name, ...(email ? { email } : {}), ...(group ? { group: true as const } : {}) },
    named: displayName !== '',
  };
}

function fromLine(line: string, groupAddresses: Set<string>): Read | null {
  const text = line.replace(BULLET, '').replace(MAIL_LINK, '$1').trim();
  if (text === '' || /^-{3,}$/.test(text)) return null;
  const options = { explicitGroup: false, groupAddresses };
  const split = DASHED.exec(text) ?? BRACKETED.exec(text);
  if (split !== null) return attendee(split[1] ?? '', split[2] ?? '', options);
  const bare = text.replace(TRAILING_PUNCTUATION, '');
  return EMAIL.test(bare) ? attendee('', bare, options) : attendee(text, '', options);
}

function fromRecord(record: Record<string, unknown>, groupAddresses: Set<string>) {
  return attendee(
    oneLine(record.name, 'attendees.name'),
    oneLine(record.email, 'attendees.email'),
    {
      explicitGroup: record.group === true,
      groupAddresses,
    },
  );
}

/** CRLF, LF, or a lone CR, as the prose sections read them. */
const LINE_BREAK = /\r\n?|\n/;

function entries(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value.split(LINE_BREAK);
  if (Array.isArray(value)) {
    return value.flatMap((each) => (typeof each === 'string' ? each.split(LINE_BREAK) : [each]));
  }
  throw new MeetingMappingError(`attendees: expected lines or a list, got ${typeof value}`);
}

/**
 * The attendees, from Gemini's `Name — email` lines (with or without a
 * mailto link), a list of such lines, or a list of `{ name, email, group }`.
 * The same address twice is one attendee: the first with a display name, or
 * the first of all when none has one.
 */
export function readAttendees(value: unknown, groupAddresses: readonly string[]): Attendee[] {
  const groups = new Set(groupAddresses.map(emailKey));
  const byKey = new Map<string, Read>();
  for (const entry of entries(value)) {
    const read =
      typeof entry === 'object' && entry !== null
        ? fromRecord(entry as Record<string, unknown>, groups)
        : fromLine(oneLine(entry), groups);
    if (read === null) continue;
    const { email, name } = read.attendee;
    const key = email === undefined ? name.toLowerCase() : emailKey(email);
    const kept = byKey.get(key);
    if (kept === undefined || (!kept.named && read.named)) byKey.set(key, read);
  }
  return [...byKey.values()].map((each) => each.attendee);
}
