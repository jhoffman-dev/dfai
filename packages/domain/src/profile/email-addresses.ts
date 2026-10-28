import { emailKey } from '../meetings/mapping/meeting-email-key.ts';

/**
 * Email addresses as the vault's settings hold them and as Settings reads
 * what is typed: strictly, so nothing that is not an address is ever kept as
 * one (P28-12). The owner's own addresses (`selfEmails`) and Granola's group
 * addresses are both read here.
 */

/** A setting of addresses as read: the addresses, or none and why. */
export interface AddressesSetting {
  readonly addresses: readonly string[];
  readonly problem: string | null;
}

const NO_ADDRESSES: AddressesSetting = { addresses: [], problem: null };

/** What a list item that is not text is named as: never its whole content. */
const nameOfValue = (value: unknown) =>
  typeof value === 'object' && value !== null ? 'a nested value' : String(value);

/**
 * The addresses a setting holds, read as strictly as typed ones: text is read
 * as Settings reads what is typed, and each item of a list must be one
 * address (an empty item is nothing). Anything else is not kept as an
 * address: the setting reads as none, and says why.
 */
export function addressesOf(value: unknown): AddressesSetting {
  if (value === undefined || value === null) return NO_ADDRESSES;
  if (typeof value === 'string') {
    const read = readAddresses(value);
    return read.ok
      ? { addresses: read.emails, problem: null }
      : { addresses: [], problem: read.problem };
  }
  if (!Array.isArray(value))
    return { addresses: [], problem: 'It is not a list of email addresses.' };
  const kept: string[] = [];
  const refused: string[] = [];
  for (const item of value as readonly unknown[]) {
    const text = typeof item === 'string' ? trimBlanks(withPlainSpaces(item)) : null;
    if (item === null || text === '') continue;
    if (text !== null && isAddress(text)) kept.push(asKept(text));
    else refused.push(text ?? nameOfValue(item));
  }
  if (refused.length > 0) return { addresses: [], problem: notAddresses(refused) };
  return { addresses: onceEach(kept), problem: null };
}

/** Typed addresses as read: the addresses, or why they cannot be kept. */
export type AddressesReading =
  | { readonly ok: true; readonly emails: readonly string[] }
  | { readonly ok: false; readonly problem: string };

/** The most text read as addresses: more is a paste of something else. */
const MOST_ADDRESS_BYTES = 10 * 1024;
/** The most of one refused entry a problem shows, in code points. */
const SHOWN_ENTRY_LENGTH = 60;
/** The most refused entries a problem names. */
const NAMED_ENTRIES = 5;

/** No-break spaces, as copies from mail and documents carry: read as the plain space. */
const NO_BREAK_SPACES = /[\u00A0\u202F\u2007]/g;
const withPlainSpaces = (text: string) => text.replace(NO_BREAK_SPACES, ' ');
/** Spaces and tabs off both ends, and nothing else: an invisible character is kept, to be refused. */
function trimBlanks(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isBlank(text[start] ?? '')) start += 1;
  while (end > start && isBlank(text[end - 1] ?? '')) end -= 1;
  return text.slice(start, end);
}

/**
 * What a local part's atoms and a domain's labels may hold: the RFC 5322
 * atext of a local part, and letters, marks and numbers of any script.
 * One class, not alternatives, so matching never backtracks.
 */
const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\p{L}\p{M}\p{N}]+$/u;
const DOMAIN_LABEL = /^[A-Za-z0-9\-\p{L}\p{M}\p{N}]+$/u;
/** Letters that show nothing, such as fillers, are no part of an address. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * One address and nothing else: a dot-atom local part (no empty atom), an @,
 * and a domain of at least two labels, none empty and none starting or
 * ending with a hyphen. No control, format or space character anywhere.
 */
function isAddress(text: string): boolean {
  const parts = text.split('@');
  if (parts.length !== 2 || INVISIBLE.test(text)) return false;
  const [local, domain] = parts as [string, string];
  const labels = domain.split('.');
  return (
    local.split('.').every((atom) => LOCAL_ATOM.test(atom)) &&
    labels.length >= 2 &&
    labels.every(
      (label) => DOMAIN_LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'),
    )
  );
}

/** UTF-8 bytes of `text`, the measure of {@link MOST_ADDRESS_BYTES}. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Any character that does not show as itself: escaped, so a refusal names what is really there. */
const NOT_SHOWN = /[^\p{L}\p{M}\p{N}\p{P}\p{S} ]|\p{Default_Ignorable_Code_Point}/gu;

const escaped = (character: string) =>
  `\\u${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

/** An entry as a problem names it: what does not show escaped, cut short. */
function shownEntry(entry: string): string {
  const characters = Array.from(entry.replace(NOT_SHOWN, escaped));
  const shown = characters.slice(0, SHOWN_ENTRY_LENGTH).join('');
  return characters.length > SHOWN_ENTRY_LENGTH ? `${shown}…` : shown;
}

/** Names the entries that are not addresses, the first few of them. */
function notAddresses(entries: readonly string[]): string {
  const named = entries.slice(0, NAMED_ENTRIES).map((each) => `“${shownEntry(each)}”`);
  const more = entries.length - named.length;
  const rest = more > 0 ? ` and ${more} more` : '';
  return `Not an email address: ${named.join(', ')}${rest}.`;
}

/** A word typed, or a quoted name. */
interface Word {
  readonly text: string;
  readonly quoted: boolean;
}

const isBlank = (character: string) => character === ' ' || character === '\t';
const isLineBreak = (character: string) => character === '\n' || character === '\r';
const isSeparator = (character: string) => character === ',' || character === ';';
const endsWord = (character: string) =>
  isBlank(character) ||
  isLineBreak(character) ||
  isSeparator(character) ||
  character === '<' ||
  character === '"';

/** Where a quoted name that starts at `start` ends, past its closing quote; -1 when it never closes. */
function quotedEnd(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === '"') return at + 1;
    at += text[at] === '\\' ? 2 : 1;
  }
  return -1;
}

/** Where `<…>` that starts at `start` stops: at its `>`, or at what shows it never closes. */
function angleEnd(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length && text[at] !== '>' && text[at] !== '<' && !isLineBreak(text[at] ?? '')) {
    at += 1;
  }
  return at;
}

/**
 * Reads typed addresses in one pass, each character looked at a fixed number
 * of times: words gather until a comma, a semicolon, a new line or the end,
 * where each must be an address; `<address>` takes the words before it as
 * its name (keeping any of them that is itself an address), even across a
 * line break.
 */
class AddressScanner {
  readonly found: string[] = [];
  readonly refused: string[] = [];
  private words: Word[] = [];
  private brokeLine = false;
  private at = 0;

  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  scan(): void {
    const { text } = this;
    while (this.at < text.length) {
      const character = text[this.at] ?? '';
      if (isBlank(character)) this.at += 1;
      else if (isLineBreak(character)) {
        this.brokeLine = true;
        this.at += 1;
      } else if (isSeparator(character)) {
        this.endEntry();
        this.at += 1;
      } else if (character === '<') this.angled();
      else this.word(character);
    }
    this.endEntry();
  }

  /** Each word gathered must be an address on its own. */
  private endEntry(): void {
    for (const { text, quoted } of this.words) {
      (!quoted && isAddress(text) ? this.found : this.refused).push(text);
    }
    this.words = [];
    this.brokeLine = false;
  }

  private word(first: string): void {
    // A word on a new line starts a new entry; only `<address>` may follow its name there.
    if (this.brokeLine) this.endEntry();
    const { text } = this;
    if (first === '"') {
      const end = quotedEnd(text, this.at);
      if (end === -1) {
        this.refused.push(text.slice(this.at));
        this.at = text.length;
        return;
      }
      this.words.push({ text: text.slice(this.at, end), quoted: true });
      this.at = end;
      return;
    }
    let end = this.at;
    while (end < text.length && !endsWord(text[end] ?? '')) end += 1;
    this.words.push({ text: text.slice(this.at, end), quoted: false });
    this.at = end;
  }

  /** `<address>`, with the words before it as its name. */
  private angled(): void {
    const { text } = this;
    const end = angleEnd(text, this.at);
    const closed = text[end] === '>';
    const angle = text.slice(this.at, closed ? end + 1 : end);
    const address = closed ? trimBlanks(angle.slice(1, -1)) : '';
    const name = this.words.map((each) => each.text);
    for (const { text: word, quoted } of this.words)
      if (!quoted && isAddress(word)) this.found.push(word);
    if (closed && isAddress(address)) this.found.push(address);
    else this.refused.push([...name, angle].join(' '));
    this.words = [];
    this.brokeLine = false;
    this.at = closed ? end + 1 : end;
  }
}

/** Typed addresses read, or why they cannot be: the core of each reading of addresses. */
export function readAddresses(typed: string): AddressesReading {
  if (typed.length > MOST_ADDRESS_BYTES || utf8Length(typed) > MOST_ADDRESS_BYTES) {
    return {
      ok: false,
      problem: 'That is more than 10 KB of text, too much to be email addresses.',
    };
  }
  const scanner = new AddressScanner(withPlainSpaces(typed));
  scanner.scan();
  if (scanner.refused.length > 0) return { ok: false, problem: notAddresses(scanner.refused) };
  return { ok: true, emails: onceEach(scanner.found.map(asKept)) };
}

/**
 * An address as it is kept: composed (NFC), as Granola and calendars send
 * it, and in lower case. One typed decomposed (an é as e and an accent) is
 * then the same address as the one a meeting lists.
 */
const asKept = (address: string) => address.normalize('NFC').toLowerCase();

/** Each address once, the first as typed: two that are one address ({@link emailKey}) are kept once. */
function onceEach(addresses: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const each of addresses) if (!byKey.has(emailKey(each))) byKey.set(emailKey(each), each);
  return [...byKey.values()];
}
