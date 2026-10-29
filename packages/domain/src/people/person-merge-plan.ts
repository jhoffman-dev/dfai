import { splitWikiLinks } from '../markdown/wikilink.ts';
import { digestOf } from '../sources/merge.ts';
import { emailKey } from '../meetings/mapping/meeting-email-key.ts';
import {
  PERSON_EMAIL_KEY,
  PERSON_OTHER_EMAILS_KEY,
} from '../meeting-links/meeting-link-queries.ts';
import { ALIASES_KEY } from '../terms/term.ts';
import { vocabularyKey } from '../terms/spelling.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { PERSON_TYPE } from './person.ts';

/** A person's note as a merge reads it: its properties as plain values, and its body. */
export interface MergeNote {
  readonly path: VaultPath;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/** A value the kept note keeps although a merged note says otherwise: shown in the preview. */
export interface MergeConflict {
  readonly key: string;
  readonly kept: unknown;
  readonly other: unknown;
  readonly from: VaultPath;
}

/** A merged note's body, to go at the end of the kept one under its heading. */
export interface AppendedBody {
  readonly from: VaultPath;
  readonly heading: string;
  readonly body: string;
}

/** What merging people into one changes in the kept note — before any link is re-pointed. */
export interface PersonMergePlan {
  /** Frontmatter keys to write on the kept note, each its whole new value. */
  readonly changes: Readonly<Record<string, unknown>>;
  readonly conflicts: readonly MergeConflict[];
  readonly aliasesAdded: readonly string[];
  readonly emailsAdded: readonly string[];
  readonly appended: readonly AppendedBody[];
}

/** Why these people cannot be merged, in the words the person is shown; null when they can. */
export function personMergeRefusal({
  kept,
  duplicates,
}: {
  kept: Pick<MergeNote, 'path' | 'properties'>;
  duplicates: readonly Pick<MergeNote, 'path' | 'properties'>[];
}): string | null {
  if (duplicates.length === 0) return 'Pick at least one person to merge.';
  const paths = duplicates.map((note) => note.path);
  if (paths.includes(kept.path)) return `${noteTitle(kept.path)} cannot be merged into itself.`;
  if (new Set(paths).size !== paths.length) return 'A person is listed twice.';
  const notPerson = [kept, ...duplicates].find((note) => !declaresPerson(note.properties));
  return notPerson === undefined ? null : `${noteTitle(notPerson.path)} is not a person.`;
}

/** Whether a note's `type` names a person, alone or among others. */
function declaresPerson(properties: Readonly<Record<string, unknown>>): boolean {
  const type = properties['type'];
  const types = Array.isArray(type) ? (type as unknown[]) : [type];
  return types.some((each) => typeof each === 'string' && each.trim() === PERSON_TYPE);
}

/** Keys merged by their own rule, not the general one. */
const OWN_RULES = new Set([ALIASES_KEY, PERSON_EMAIL_KEY, PERSON_OTHER_EMAILS_KEY]);

/** The key every type a note has is joined under: none is ever dropped. */
const TYPE_KEY = 'type';

/**
 * How `duplicates` merge into `kept` (#464), in the order given:
 *
 * - Lists are joined, never dropped: each item the kept note lacks is added after its own.
 *   A merged list joined to a kept single value makes a list, the kept value first.
 * - Types are always joined, the kept note's first: a person who is also a contractor stays one.
 * - A value the kept note has none of is taken from the first merged note that has one.
 * - Two different single values keep the kept note's; the other is a {@link MergeConflict}.
 * - A merged value that is only a link to the kept person or a merged one is left out:
 *   kept, it would be the person linking to themselves.
 * - Addresses: a merged `email` the kept note has none of becomes its `email`;
 *   every other address it lacks goes into `other_emails`, so meeting import finds it.
 * - Aliases: each merged note's aliases and its title, so an attendee by that name is still them.
 * - Bodies: each merged note's, under a heading naming it ({@link mergedBody}).
 */
export function planPersonMerge({
  kept,
  duplicates,
  resolve = () => null,
}: {
  kept: MergeNote;
  duplicates: readonly MergeNote[];
  /** Where a link's target opens, among the vault's notes before the merge. */
  resolve?: (target: string) => VaultPath | null;
}): PersonMergePlan {
  const merging = new Set<string>([kept.path, ...duplicates.map((note) => note.path)]);
  const selfLink = (value: unknown) =>
    typeof value === 'string' && opensOneOf(value, merging, resolve);
  const values: Record<string, unknown> = { ...kept.properties };
  const conflicts: MergeConflict[] = [];
  for (const duplicate of duplicates) {
    for (const [key, written] of Object.entries(duplicate.properties)) {
      const other = withoutSelfLinks(written, selfLink);
      if (OWN_RULES.has(key) || isEmpty(other)) continue;
      const merged =
        key === TYPE_KEY ? joinedTypes(values[key], other) : mergeValue(values[key], other);
      if (merged.conflict) conflicts.push({ key, kept: values[key], other, from: duplicate.path });
      else values[key] = merged.value;
    }
  }
  const emails = mergeEmails(kept, duplicates);
  const aliases = mergeAliases(kept, duplicates);
  return {
    changes: { ...changedKeys(kept.properties, values), ...emails.changes, ...aliases.changes },
    conflicts,
    aliasesAdded: aliases.added,
    emailsAdded: emails.added,
    appended: appendedBodies(kept, duplicates),
  };
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return Array.isArray(value) && value.every(isEmpty);
}

/** A value as two are compared: text spelt as the Terms page compares it, anything else as JSON. */
function comparable(value: unknown): string {
  return typeof value === 'string' ? `s:${vocabularyKey(value)}` : `j:${JSON.stringify(value)}`;
}

/** The kept list with each item of `more` it lacks added after its own. */
function union(kept: readonly unknown[], more: readonly unknown[]): unknown[] {
  const seen = new Set(kept.map(comparable));
  const joined = [...kept];
  for (const item of more) {
    if (isEmpty(item) || seen.has(comparable(item))) continue;
    seen.add(comparable(item));
    joined.push(item);
  }
  return joined;
}

function mergeValue(kept: unknown, other: unknown): { value?: unknown; conflict: boolean } {
  if (isEmpty(kept)) return { value: other, conflict: false };
  if (Array.isArray(kept)) {
    return { value: union(kept, Array.isArray(other) ? other : [other]), conflict: false };
  }
  if (Array.isArray(other)) {
    const joined = union([kept], other);
    return { value: joined.length === 1 ? kept : joined, conflict: false };
  }
  return comparable(other) === comparable(kept)
    ? { value: kept, conflict: false }
    : { conflict: true };
}

/** Every type of both notes, the kept note's first; a single type stays written as one. */
function joinedTypes(kept: unknown, other: unknown): { value: unknown; conflict: false } {
  const joined = union(asList(kept), asList(other));
  return { value: joined.length === 1 && !Array.isArray(kept) ? kept : joined, conflict: false };
}

const asList = (value: unknown): unknown[] =>
  isEmpty(value) ? [] : Array.isArray(value) ? value : [value];

/** A value with every item that is only a link to one of the people merging taken out. */
function withoutSelfLinks(value: unknown, selfLink: (item: unknown) => boolean): unknown {
  if (Array.isArray(value)) return value.filter((item) => !selfLink(item));
  return selfLink(value) ? null : value;
}

/** Whether text is one wiki link, alone, that opens one of `paths`. */
function opensOneOf(
  text: string,
  paths: ReadonlySet<string>,
  resolve: (target: string) => VaultPath | null,
): boolean {
  const pieces = splitWikiLinks(text.trim());
  const [only] = pieces;
  if (pieces.length !== 1 || only?.kind !== 'wikiLink') return false;
  const opened = resolve(only.target.trim());
  return opened !== null && paths.has(opened);
}

/** The keys whose merged value differs from the kept note's own. */
function changedKeys(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key]),
    ),
  );
}

/** A property's items, a single value read as a list of one; only text. */
function texts(value: unknown): string[] {
  const items = Array.isArray(value) ? (value as unknown[]) : [value];
  return items.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function mergeEmails(
  kept: MergeNote,
  duplicates: readonly MergeNote[],
): { changes: Record<string, unknown>; added: string[] } {
  const own = texts(kept.properties[PERSON_EMAIL_KEY]);
  const others = texts(kept.properties[PERSON_OTHER_EMAILS_KEY]);
  const seen = new Set([...own, ...others].map(emailKey));
  const added: string[] = [];
  for (const duplicate of duplicates) {
    for (const address of [
      ...texts(duplicate.properties[PERSON_EMAIL_KEY]),
      ...texts(duplicate.properties[PERSON_OTHER_EMAILS_KEY]),
    ]) {
      if (seen.has(emailKey(address))) continue;
      seen.add(emailKey(address));
      added.push(address.trim());
    }
  }
  if (added.length === 0) return { changes: {}, added };
  const [first, ...rest] = added;
  const takesEmail = own.length === 0 && first !== undefined;
  const changes: Record<string, unknown> = takesEmail ? { [PERSON_EMAIL_KEY]: first } : {};
  const moreOthers = takesEmail ? rest : added;
  if (moreOthers.length > 0) changes[PERSON_OTHER_EMAILS_KEY] = [...others, ...moreOthers];
  return { changes, added };
}

function mergeAliases(
  kept: MergeNote,
  duplicates: readonly MergeNote[],
): { changes: Record<string, unknown>; added: string[] } {
  const own = texts(kept.properties[ALIASES_KEY]);
  const seen = new Set([noteTitle(kept.path), ...own].map(vocabularyKey));
  const added: string[] = [];
  for (const duplicate of duplicates) {
    for (const alias of [noteTitle(duplicate.path), ...texts(duplicate.properties[ALIASES_KEY])]) {
      const key = vocabularyKey(alias);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      added.push(alias.trim());
    }
  }
  return added.length === 0
    ? { changes: {}, added }
    : { changes: { [ALIASES_KEY]: [...own, ...added] }, added };
}

/**
 * Each merged note's body that holds anything, under `Merged from <title>` —
 * or its path, where its title would not tell it from the kept note or
 * another merged one (`Tobias Fenn.md` and `People/Tobias Fenn.md`).
 */
function appendedBodies(kept: MergeNote, duplicates: readonly MergeNote[]): AppendedBody[] {
  const titles = [kept, ...duplicates].map((note) => vocabularyKey(noteTitle(note.path)));
  const keptBody = kept.body.replace(/\r\n/gu, '\n');
  return duplicates.flatMap((duplicate) => {
    const body = duplicate.body.replace(/^(?:[ \t]*\r?\n)+/u, '').trimEnd();
    if (body === '') return [];
    const title = noteTitle(duplicate.path);
    const shared = titles.filter((each) => each === vocabularyKey(title)).length > 1;
    const name = shared ? duplicate.path.replace(/\.md$/iu, '') : title;
    const heading = `## Merged from ${name}`;
    // Merged before — a run the Trash stopped, say: the text is there once already.
    if (keptBody.includes(`${heading}\n\n${body.replace(/\r\n/gu, '\n')}`)) return [];
    return [{ from: duplicate.path, heading, body }];
  });
}

/**
 * The kept note's body with each merged body after it, each under its
 * heading. The kept body's own bytes are untouched: the merge only adds.
 */
export function mergedBody(keptBody: string, appended: readonly AppendedBody[]): string {
  if (appended.length === 0) return keptBody;
  const newline = keptBody.includes('\r\n') ? '\r\n' : '\n';
  const ending = keptBody === '' || keptBody.endsWith('\n') ? '' : newline;
  const sections = appended.map(({ heading, body }) =>
    [heading, '', body.replace(/\r?\n/gu, newline), ''].join(newline),
  );
  const gap = keptBody.trim() === '' ? '' : newline;
  return `${keptBody}${ending}${gap}${sections.join(newline)}`;
}

/**
 * One token for a merge as previewed: a digest of each file it read, by path,
 * and of its plan. Two previews of the same files give the same token; any
 * byte changed in any of them, or a different plan, gives another (#464).
 */
export function mergeVersion({
  read,
  plan,
}: {
  read: readonly { readonly path: string; readonly text: string }[];
  plan: PersonMergePlan;
}): string {
  const files = [...read]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, text }) => digestOf(`${path}\u0000${text}`));
  return [...files, digestOf(JSON.stringify(plan))].join('');
}
