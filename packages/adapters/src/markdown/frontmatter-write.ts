import {
  Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  Lexer,
  parseDocument,
  visit,
  type Node,
  Pair,
  type Scalar,
  YAMLMap,
  type YAMLError,
  type YAMLSeq,
} from 'yaml';
import { FrontmatterRefusedError } from '@dfai/application';
import { KeyAsWritten } from '@dfai/domain';
import { withOriginalEndings } from './line-endings.ts';

/**
 * Changes some keys of a frontmatter block and leaves everything else alone.
 *
 * The block is edited as a YAML document rather than rebuilt from parsed values,
 * so comments, key order, quoting style and block-vs-inline lists all survive.
 * Setting a value to null or undefined removes the key.
 *
 * A changed list or map is written into the one that was there, not over it:
 * items and keys that still hold the same values keep their nodes, so a
 * dashboard's other widgets keep their comments, quoting and inline lists when
 * one widget is edited, and a list that was inline stays inline.
 *
 * A key that was not changed is written back as the exact text it was found
 * as — its indentation, spacing and folded strings included — since
 * re-stringifying it would normalise all of them.
 *
 * An anchor on the node being changed (or anything inside it) that other keys
 * refer to moves to the first of them, holding the value it had: editing
 * `tags: &t [a, b]` never changes an `other: *t`, and removing `tags` never
 * leaves `other` pointing at nothing. The link is broken only for the key that
 * was edited — the least surprising of the choices, since the person editing
 * one property cannot see the others it would otherwise change.
 *
 * The `---` delimiters and the line endings are reused exactly as they were
 * found, so a file written on Windows stays written on Windows: each line the
 * change leaves keeps its own ending, a changed line the ending of the line
 * it replaced, and a new line the ending most of the block's lines have —
 * the opening's when there are as many of each.
 *
 * A change given as {@link KeyAsWritten} is written as exactly that text, in
 * the key's place — how archiving gives a note back its own keys — moved from
 * the column its key is written at to the block's. Text that is not that one
 * key, alone, is not written: the key is removed instead, since it could
 * otherwise break the block around it.
 *
 * A change that writes to a block that cannot be read is refused with a
 * {@link FrontmatterRefusedError}, on the key it would write.
 *
 * A property that lists a key twice is refused with a
 * {@link FrontmatterRefusedError} — which of the two was meant cannot be told —
 * while a change to any other key still writes only that key's bytes.
 */
export function updateFrontmatter(
  frontmatter: string | null,
  changes: Readonly<Record<string, unknown>>,
): string {
  const { opening, body, closing, content } = split(frontmatter);
  const eol = opening.endsWith('\r\n') ? '\r\n' : '\n';
  const source = body.replace(/\r\n/g, '\n');

  const document = parsedForWriting(source, Object.keys(changes));
  // A key given the value it already holds is no change: its line keeps its bytes.
  const changed = Object.entries(changes).filter(([key, value]) => !holds(document, key, value));
  // Nothing to write — only removals of keys that are not there — leaves the
  // block as it was found, so a comment-only or empty block is not re-rendered.
  if (frontmatter !== null && changed.every(([key, value]) => absent(document, key, value))) {
    return frontmatter;
  }
  refuseUnreadable(
    document,
    changed.find(([key, value]) => !absent(document, key, value))?.[0] ?? '',
  );

  const lists = listIndent(
    document,
    source,
    changed.map(([key]) => key),
  );
  const before = segments(source);
  const was = readBody(source);
  const found = changesAMap(document, changed) ? rendered(document, lists) : null;
  const edit = applyChanges(document, changed, before);
  if (isEmptiedBlockMap(document)) {
    // The library would write `{}`; what is left is what stood around the
    // keys — comments and blank lines before the first and after the last —
    // and a block with nothing in it at all is just its delimiters.
    // Comments heading the block lose the blank lines the library put under
    // them; a head that is only blank lines was the note's own, and stays.
    const head = before?.head ?? '';
    const kept = head.trim() === '' ? head : head.replace(/\n+$/, '\n');
    const left = withOriginalEndings({
      original: content,
      edited: `${kept}${before?.tail ?? ''}`,
      fallback: eol,
    });
    return `${opening}${left}${closing}`;
  }
  // Blank lines were all a block held: they stay above the keys it now has.
  const blank = source.trim() === '' ? content.replace(/\r\n/g, '\n') : '';
  const written = checkedBody({ document, before, edit, was, blank, lists, found });
  const ended = withOriginalEndings({ original: content, edited: `${written}\n`, fallback: eol });
  return `${opening}${ended}${closing}`;
}

/** What {@link applyChanges} did, for writing the block. */
export interface Edit {
  /** Pairs' ids whose text the change reaches. */
  readonly touched: Set<string>;
  /** Pairs' ids whose text is given, written as that text wherever they stand. */
  readonly asWritten: Map<string, string>;
  /** Pairs whose comments below the value were taken off it, and how to put them back. */
  readonly cleared: Map<string, () => void>;
  /** The keys changed, removed or added. */
  readonly keys: ReadonlySet<string>;
}

/** Makes each change on the document. */
function applyChanges(
  document: Document,
  changed: readonly (readonly [string, unknown])[],
  before: Segments | null,
): Edit {
  const edit: Edit = {
    touched: new Set(),
    asWritten: new Map(),
    cleared: new Map(),
    keys: new Set(changed.map(([key]) => key)),
  };
  for (const [key, change] of changed) {
    const node = change instanceof KeyAsWritten ? writtenValue(key, change.text) : undefined;
    const removing = node === null || change === null || change === undefined;
    for (const holder of releaseAnchors(document, key, removing)) edit.touched.add(holder);
    // Only the pair the reader reads is written; a shadowed one keeps its bytes.
    const id = idOf(key, Math.max(pairsOf(document, key).length - 1, 0));
    edit.touched.add(id);
    if (node === undefined) {
      setKey(document, key, change);
      const putBack = removing ? null : clearCommentBelow(document, key, before);
      if (putBack !== null) edit.cleared.set(id, putBack);
    } else if (node === null) setKey(document, key, null);
    else {
      edit.asWritten.set(id, (change as KeyAsWritten).text);
      putNode(document, key, node);
    }
  }
  return edit;
}

/**
 * The block's new text, checked by reading it back (ADR-0003): it must read
 * as the document now holds, every key the change did not name as it was
 * found. Written with #430's rules first and #395's if those read back
 * wrong; a change neither writes right is refused, the note left as it was.
 */
export function checkedBody({
  document,
  before,
  edit,
  was,
  blank,
  lists,
  found = null,
  compose = composed,
}: {
  document: Document;
  before: Segments | null;
  edit: Edit;
  was: Record<string, unknown> | null;
  blank: string;
  lists: ReturnType<typeof listIndent>;
  /** The block as the library wrote it before the change, when the change reaches a map. */
  found?: string | null;
  /** How the block is written under each set of rules; its test gives one that writes it wrong. */
  compose?: typeof composed;
}): string {
  const wanted = valuesOf(document);
  for (const rules of ['kept', 'main'] as const) {
    const write = (entriesFrom: string | null) =>
      `${blank}${compose({ document, before, edit, lists, rules, found: entriesFrom })}`;
    // Written as before first, so that writing is the same whatever follows.
    const whole = write(null);
    // A map's entries kept as found (#697), when that reads back right and
    // keeps its comments: the rest of the writing places comments with the
    // rules of the map written whole.
    const byEntry = found === null ? null : write(found);
    if (
      byEntry !== null &&
      keepsComments({ written: byEntry, whole, source: textOf(before) }) &&
      readsBack(byEntry, wanted, was, edit.keys)
    ) {
      return byEntry;
    }
    if (readsBack(whole, wanted, was, edit.keys)) return whole;
    for (const putBack of edit.cleared.values()) putBack();
    edit.cleared.clear();
  }
  throw new FrontmatterRefusedError({
    key: [...edit.keys][0] ?? '',
    message:
      "DFAI could not write this change without changing the note's other properties, so the note was left as it was. Change it in the source instead.",
  });
}

/** The block as the library writes it, every key it need not have written put back as found. */
function composed({
  document,
  before,
  edit,
  lists,
  rules,
  found = null,
}: {
  document: Document;
  before: Segments | null;
  edit: Edit;
  lists: ReturnType<typeof listIndent>;
  rules: Rules;
  /** The block as the library wrote it before the change; null writes each changed map whole. */
  found?: string | null;
}): string {
  const write = () =>
    keepUntouched({
      before,
      written: withEntriesKept({ written: rendered(document, lists), found, before, edit }),
      edit,
      rules,
    });
  const first = write();
  if (first.unplaced.length === 0) return first.text;
  // A key whose comments below could not be put back under it is the
  // library's to write, those comments and all.
  for (const id of first.unplaced) {
    edit.cleared.get(id)?.();
    edit.cleared.delete(id);
  }
  return write().text;
}

/**
 * Whether `written` holds every comment `whole` does, and none more often
 * than `whole` or the `source` block does: it may keep one the library would
 * drop with a key taken away, but never loses or repeats one.
 */
function keepsComments({
  written,
  whole,
  source,
}: {
  written: string;
  whole: string;
  source: string;
}): boolean {
  const counted = (text: string) => {
    const counts = new Map<string, number>();
    for (const comment of commentsOf(text)) counts.set(comment, (counts.get(comment) ?? 0) + 1);
    return counts;
  };
  const [has, wholeHas, sourceHas] = [counted(written), counted(whole), counted(source)];
  const at = (counts: Map<string, number>, comment: string) => counts.get(comment) ?? 0;
  return (
    [...wholeHas].every(([comment, count]) => at(has, comment) >= count) &&
    [...has].every(
      ([comment, count]) => count <= Math.max(at(wholeHas, comment), at(sourceHas, comment)),
    )
  );
}

/** The block a {@link Segments} was cut from; empty when there was none. */
const textOf = (before: Segments | null) =>
  before === null
    ? ''
    : `${before.head}${before.keys.map((key) => key.text).join('')}${before.tail}`;

/** The block as the library writes it, without the newline it ends with. */
function rendered(document: Document, lists: ReturnType<typeof listIndent>): string {
  return document
    .toString({
      // Never wrap: a long value must not gain a line break it did not have.
      lineWidth: 0,
      // `[one, two]` rather than `[ one, two ]`, so an untouched inline list is
      // written back exactly as it was found.
      flowCollectionPadding: false,
      ...lists,
    })
    .replace(/\n$/, '');
}

/** Whether a change reaches a key whose value is a map written in block style. */
function changesAMap(document: Document, changed: readonly (readonly [string, unknown])[]) {
  return changed.some(([key]) => isBlockMap(pairOf(document, key)?.value));
}

const isBlockMap = (node: unknown) => isMap(node) && node.flow !== true;

/** What a block's YAML reads as, duplicates read as their last; null when it cannot be read. */
function readBody(body: string): Record<string, unknown> | null {
  if (body.trim() === '') return {};
  const document = parseDocument(body, { uniqueKeys: false });
  return document.errors.length > 0 ? null : valuesOf(document);
}

/** The document's values; null when they cannot be had (an alias too deep to expand). */
function valuesOf(document: Document): Record<string, unknown> | null {
  try {
    const values: unknown = document.toJS();
    if (values === null || values === undefined) return {};
    return isPlainObject(values) ? values : null;
  } catch {
    // An unreadable value: the caller treats the block as one it cannot check.
    return null;
  }
}

/**
 * Whether the written `body` reads as `wanted`, and every key not among
 * `changed` reads as it `was`. Nothing to compare with (`wanted` null)
 * asks only that it can be read.
 */
function readsBack(
  body: string,
  wanted: Record<string, unknown> | null,
  was: Record<string, unknown> | null,
  changed: ReadonlySet<string>,
): boolean {
  const read = readBody(body);
  if (read === null) return false;
  if (wanted === null) return true;
  const keys = Object.keys(read);
  if (keys.length !== Object.keys(wanted).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(wanted, key) &&
      readsTheSame(read[key], wanted[key]) &&
      (was === null || changed.has(key) || readsTheSame(read[key], was[key])),
  );
}

/**
 * The block as a document to write. A key written twice is an error the library
 * will not write past, so such a block is read again with duplicates allowed —
 * once no change names the property that holds one. A duplicate that no
 * property holds (inside a key written as a map) refuses every change, since
 * none can be shown not to touch it.
 */
function parsedForWriting(source: string, changing: readonly string[]): Document {
  // An empty block parses to null and has nothing to set keys on. Starting from a
  // fresh Document gives a block map; parsing `{}` would give a flow one and write
  // `{title: New}` on a single line.
  if (source.trim() === '') return new Document({});
  const document = parseDocument(source);
  const found = duplicates(document);
  if (found.length === 0) return document;
  for (const placed of found) {
    const refusal = placed ?? {
      // No property holds this duplicate, so the refusal is pinned on the first
      // change asked for: it always matches below, and every change is refused.
      // With no changes at all there is nothing to refuse: '' matches none, and
      // the block is handed back as it was.
      key: changing[0] ?? '',
      message:
        "This note's properties list a key twice; fix it in the source before changing them.",
    };
    if (changing.includes(refusal.key)) throw new FrontmatterRefusedError(refusal);
  }
  return parseDocument(source, { uniqueKeys: false });
}

/**
 * Refuses `key`'s write on a block that cannot be read — keys at two columns,
 * a tab as indentation: where the change would go cannot be told, and the
 * library will not write it anyway. Only a change that writes gets here, so
 * removing a key such a block lacks stays no change.
 */
function refuseUnreadable(document: Document, key: string): void {
  const [error] = document.errors;
  if (error === undefined) return;
  throw new FrontmatterRefusedError({
    key,
    message: `This note's properties cannot be read (${problemLine(error)}); fix them in the source before changing them.`,
  });
}

/** YAML's message for an error, without the lines that draw a caret under its column. */
export function problemLine(error: YAMLError): string {
  // The first line ends in a colon that leads into the excerpt left behind.
  return (error.message.split('\n')[0] ?? error.message).replace(/:\s*$/, '');
}

/**
 * Each key the block writes twice, as the property holding it and why a change
 * to that property is refused; null for one no property holds.
 */
function duplicates(document: Document): (Refusal | null)[] {
  return document.errors
    .filter((error) => error.code === 'DUPLICATE_KEY')
    .map((error) => refusalAt(document, error.pos[0]));
}

/**
 * The top-level properties of a block's YAML that hold a key written twice,
 * each with why a change to it is refused — as {@link updateFrontmatter}
 * refuses it.
 */
export function duplicatedProperties(source: string): Refusal[] {
  return duplicates(parseDocument(source)).filter((refusal) => refusal !== null);
}

/** A property a change to which is refused, and why, in the person's words. */
interface Refusal {
  readonly key: string;
  readonly message: string;
}

/**
 * The top-level property holding the key written twice at `offset`, and why a
 * change to it is refused, in the person's words. Null when no property holds it.
 */
function refusalAt(document: Document, offset: number): Refusal | null {
  const contents = document.contents;
  if (!isMap(contents)) return null;
  const fix = 'fix it in the source before changing it.';
  for (const pair of contents.items) {
    if (!isNode(pair.key)) continue;
    const key = keyOf(pair.key, document);
    if (pair.key.range?.[0] === offset) {
      return { key, message: `This note's properties list "${key}" twice; ${fix}` };
    }
    const inner = isNode(pair.value) ? keyAt(document, pair.value, offset) : null;
    if (inner !== null) {
      return { key, message: `This note's property "${key}" lists "${inner}" twice; ${fix}` };
    }
  }
  return null;
}

/** The name of the key that starts at `offset` somewhere inside `node`, if one does. */
function keyAt(document: Document, node: Node, offset: number): string | null {
  let found: string | null = null;
  visit(node, {
    Pair: (_, pair) => {
      if (!isNode(pair.key) || pair.key.range?.[0] !== offset) return undefined;
      found = keyOf(pair.key, document);
      return visit.BREAK;
    },
  });
  return found;
}

/**
 * The value `given` gives `key`, when it is that key and nothing else: one
 * block-map entry, in text that parses cleanly once its key is at column 0.
 * Null otherwise. The value is kept as a node, so a key whose text cannot be
 * put back in — in a flow map — is still written with the value it holds.
 */
function writtenValue(key: string, given: string): Node | null {
  // Text read from an indented block is read as if at column 0: the key's own
  // indent is the block's, not part of what the key holds.
  const text = shifted(given, -keyColumnOf(given));
  if (!text.endsWith('\n') || /^(?:---|\.\.\.)(?:[ \t]|$)/m.test(text)) return null;
  const parsed = parseDocument(text);
  const contents = parsed.contents;
  if (parsed.errors.length > 0 || !isMap(contents) || contents.flow === true) return null;
  const [pair, ...others] = contents.items;
  if (pair === undefined || others.length > 0 || keyOf(pair.key, parsed) !== key) return null;
  if (!isNode(pair.key) || columnOf(text, pair.key.range?.[0]) !== 0) return null;
  // A bare `key:` may hold no node; an empty one keeps the key in its place.
  return isNode(pair.value) ? pair.value : parsed.createNode(null);
}

/** Sets `key` to a node as it stands, in the key's place, or last when the block lacks it. */
function putNode(document: Document, key: string, node: Node): void {
  const pair = pairOf(document, key);
  if (pair === undefined) document.set(key, node);
  else pair.value = node;
}

/**
 * Each top-level key of a frontmatter block with the exact text that writes
 * it — the comment lines right above it included — with `\n` line endings.
 * Nothing for a note with no block. Keys that share lines (a flow map) cannot
 * be cut apart, so each is written out on a line of its own instead: the
 * value is kept, if not its spelling.
 */
export function frontmatterKeyTexts(frontmatter: string | null): Record<string, string> {
  if (frontmatter === null) return {};
  const source = split(frontmatter).body.replace(/\r\n/g, '\n');
  const cut = segments(source);
  if (cut !== null) return Object.fromEntries(cut.keys.map(({ key, text }) => [key, text]));
  const parsed = parseDocument(source);
  const contents = parsed.contents;
  if (!isMap(contents)) return {};
  return Object.fromEntries(
    contents.items.map((pair) => {
      const alone = new Document({});
      alone.set(pair.key, pair.value);
      return [
        keyOf(pair.key, parsed),
        alone.toString({ lineWidth: 0, flowCollectionPadding: false }),
      ];
    }),
  );
}

/**
 * How deep a changed block list is written: as deep as the first changed key's
 * list was found, so `tags:` over `- a` stays at zero indent and one at four
 * spaces keeps four. The library's two spaces otherwise. Only the changed keys'
 * text is written this way — the rest is put back as it was found.
 */
function listIndent(
  document: Document,
  source: string,
  keys: readonly string[],
): { indent?: number; indentSeq?: boolean } {
  for (const key of keys) {
    const pair = pairOf(document, key);
    const list = pair?.value;
    if (!isSeq(list) || list.flow === true || !isNode(pair?.key)) continue;
    const keyColumn = columnOf(source, pair.key.range?.[0]);
    const itemColumn = columnOf(source, list.range?.[0]);
    if (keyColumn === null || itemColumn === null) continue;
    const depth = itemColumn - keyColumn;
    return depth <= 0 ? { indentSeq: false } : { indent: depth, indentSeq: true };
  }
  return {};
}

export function columnOf(source: string, offset: number | undefined): number | null {
  return offset === undefined ? null : offset - (source.lastIndexOf('\n', offset - 1) + 1);
}

/**
 * The key as the reader names it: `2024:` is the property "2024", `~:` is "",
 * and `*k :` is the key its anchor `&k` holds. Named any other way, a change
 * to such a key adds a second one that shadows it.
 */
export function keyOf(key: unknown, document: Document): string {
  if (isScalar(key) && (key.value === null || typeof key.value !== 'object')) {
    return key.value === null ? '' : String(key.value);
  }
  // An alias or a collection: named by the library itself, as the reader is,
  // from a map holding only this key.
  const alone = new YAMLMap();
  alone.items.push(new Pair(key, null));
  // The library warns on every collection key it names; the reader has
  // already warned once for this block, so naming it again is kept quiet.
  const level = document.options.logLevel;
  document.options.logLevel = 'error';
  try {
    return Object.keys(alone.toJS(document) as object)[0] ?? '';
  } finally {
    document.options.logLevel = level;
  }
}

/**
 * The pair the reader reads for `key`: the last that names it, since a later
 * spelling (`"1":` after `1:`, `"":` after `~:`) replaces an earlier one.
 */
export function pairOf(document: Document, key: string): Pair | undefined {
  return pairsOf(document, key).at(-1);
}

/** Every top-level pair that names `key`, in the order they are written. */
function pairsOf(document: Document, key: string): Pair[] {
  const contents = document.contents;
  if (!isMap(contents)) return [];
  return contents.items.filter((pair) => keyOf(pair.key, document) === key);
}

/** One top-level pair: its name, and which of the pairs with that name it is. */
const idOf = (key: string, occurrence: number) => `${key}\u0000${occurrence}`;

/** Whether the last key of a block map was just removed; a flow map stays `{}`. */
function isEmptiedBlockMap(document: Document): boolean {
  const contents = document.contents;
  return isMap(contents) && contents.items.length === 0 && contents.flow !== true;
}

/** Whether this change removes a key the block does not have. */
function absent(document: Document, key: string, value: unknown): boolean {
  return (value === null || value === undefined) && pairOf(document, key) === undefined;
}

/**
 * Whether `key` already holds `value`, alias or not. Text given as written
 * always counts as a change; so does a map whose keys are in another order.
 */
function holds(document: Document, key: string, value: unknown): boolean {
  if (value === null || value === undefined || value instanceof KeyAsWritten) return false;
  const pair = pairOf(document, key);
  if (pair === undefined || !isNode(pair.value)) return false;
  return readsTheSame(pair.value.toJS(document), value);
}

function setKey(document: Document, key: string, value: unknown): void {
  const contents = document.contents;
  const pair = pairOf(document, key);
  if (pair === undefined || !isMap(contents)) {
    // Removing a key that is not there changes nothing — and a block holding
    // only comments has no map for the library to remove it from.
    if (value !== null && value !== undefined) document.set(key, value);
  } else if (value === null || value === undefined) {
    // Every spelling of the key goes, or the reader would read an earlier one.
    const named = new Set(pairsOf(document, key));
    contents.items = contents.items.filter((item) => !named.has(item));
  } else {
    pair.value = reconcile(document, pair.value, value);
  }
}

/**
 * Before `key` is changed, gives every anchor inside it that another key
 * refers to a new home: the first alias of it — a value or a key — becomes a
 * copy of the anchored node, anchor and all, so it and every later alias keep
 * what they read, and no other key is renamed. When the key is `removing`,
 * every pair naming it goes, so an anchor on one of their keys moves too.
 * Returns the pairs whose text that changed.
 */
function releaseAnchors(document: Document, key: string, removing: boolean): string[] {
  const contents = document.contents;
  if (!isMap(contents)) return [];
  const last = pairOf(document, key);
  const edited = removing ? pairsOf(document, key) : last === undefined ? [] : [last];
  const anchored: (Scalar | YAMLMap | YAMLSeq)[] = [];
  const collect = (node: unknown) => {
    if (!isNode(node)) return;
    visit(node, (_, inner) => {
      if (isNode(inner) && !isAlias(inner) && inner.anchor !== undefined) anchored.push(inner);
    });
  };
  for (const pair of edited) {
    if (removing) collect(pair.key);
    collect(pair.value);
  }

  const holders: string[] = [];
  for (const node of anchored) {
    const name = node.anchor as string;
    const holder = () => {
      const copy = node.clone() as typeof node;
      copy.anchor = name;
      return copy;
    };
    const home = contents.items.find((pair) => {
      if (edited.includes(pair)) return false;
      const was = keyOf(pair.key, document);
      if (!rehome(pair, 'key', name, holder)) return rehome(pair, 'value', name, holder);
      // A list or map used as a key through an alias is named `*k` by the
      // reader; written out in its place it would be named by its items.
      if (keyOf(pair.key, document) !== was) {
        throw new Error(
          `Cannot change "${key}": the key "${was}" is an alias of it, and would be renamed`,
        );
      }
      return true;
    });
    if (home !== undefined) {
      delete node.anchor;
      holders.push(idOfPair(document, home));
    }
  }
  return holders;
}

/**
 * Swaps the first alias of `name` on one side of `pair` for `holder()`;
 * whether there was one.
 */
function rehome(pair: Pair, side: 'key' | 'value', name: string, holder: () => Node): boolean {
  const at: unknown = pair[side];
  const refersHere = (alias: unknown) => isAlias(alias) && alias.source === name;
  // A pair's own key or value has no parent for `visit` to swap it in, so it is set directly.
  if (refersHere(at)) {
    pair[side] = holder();
    return true;
  }
  let moved = false;
  if (isNode(at)) {
    visit(at, (_, alias) => {
      // The copy that replaces the alias is visited next; stop there.
      if (moved) return visit.BREAK;
      if (!refersHere(alias)) return undefined;
      moved = true;
      return holder();
    });
  }
  return moved;
}

/** The id of a top-level pair, as {@link segments} cuts the written block. */
function idOfPair(document: Document, pair: Pair): string {
  const named = pairsOf(document, keyOf(pair.key, document));
  return idOf(keyOf(pair.key, document), named.indexOf(pair));
}

/**
 * `value` as a node, reusing `existing` wherever it already says the same.
 * Anything else is a fresh node, written in the library's default style.
 */
function reconcile(document: Document, existing: unknown, value: unknown): unknown {
  if (!isNode(existing)) return value;
  if (sameValue(document, existing, value)) return existing;
  // An emptied list is written `[]`, a value of its own line; kept as a block
  // list, the library writes it under its key, at a column that may not read.
  if (isSeq(existing) && Array.isArray(value) && value.length > 0) {
    existing.items = reconcileItems(document, existing.items, value);
    return existing;
  }
  if (isMap(existing) && isPlainObject(value)) {
    reconcileMap(document, existing, value);
    return existing;
  }
  // A scalar keeps its node, and with it its quoting, as `set` always did —
  // but an empty value has no quoting to keep, and the comment under it
  // would be written above the new one; and a block of text emptied has no
  // text to tell its depth by, so it is written as the library writes "".
  if (isScalar(existing) && isScalarValue(value) && existing.value !== null) {
    existing.value = value;
    if (value === '' && isBlockScalar(existing)) delete existing.type;
    return existing;
  }
  if (isScalar(existing) && isScalarValue(value)) {
    const fresh = document.createNode(value);
    // Written as the empty value was, where the library can: plain.
    if (isScalar(fresh) && existing.type !== undefined) fresh.type = existing.type;
    return fresh;
  }
  return document.createNode(value);
}

/**
 * The list's new items, each the old node that holds the same value if there
 * is one — so a reordered list moves its nodes rather than rewriting them.
 * An item that changed is written into the node that stood in its place, or,
 * when that one has moved on, the first node left over — changed as little as
 * it can be. Only what is left over after that is made afresh.
 */
function reconcileItems(document: Document, items: readonly unknown[], values: readonly unknown[]) {
  const claimed = new Set<number>();
  const claim = (at: number) => {
    claimed.add(at);
    return items[at];
  };
  const matched = values.map((value) => {
    const at = items.findIndex(
      (item, index) => !claimed.has(index) && sameValue(document, item, value),
    );
    return at === -1 ? undefined : claim(at);
  });
  return values.map((value, at) => {
    if (matched[at] !== undefined) return matched[at];
    const spare =
      at < items.length && !claimed.has(at)
        ? at
        : items.findIndex((_, index) => !claimed.has(index));
    return spare === -1 ? document.createNode(value) : reconcile(document, claim(spare), value);
  });
}

/**
 * The map's keys set to `value`'s, each written into the pair that held it,
 * and put in `value`'s order — so a property moved or renamed in an editor
 * lands where the editor put it, and a new key where it was added. A key
 * gone whose value comes back under a new key was renamed: its pair takes
 * the new name and keeps its value as written, and the comment and blank
 * line above it (#697).
 */
function reconcileMap(
  document: Document,
  existing: { items: { key: unknown; value: unknown }[] },
  value: Readonly<Record<string, unknown>>,
): void {
  const gone = existing.items.filter((pair) => !Object.hasOwn(value, keyOf(pair.key, document)));
  existing.items = existing.items.filter((pair) => !gone.includes(pair));
  for (const [key, wanted] of Object.entries(value)) {
    // The last spelling of a key is the one the reader reads.
    const pair = existing.items.findLast((item) => keyOf(item.key, document) === key);
    const renamed = pair === undefined ? renamedPair(document, gone, wanted) : undefined;
    if (renamed !== undefined) {
      (renamed.key as Scalar).value = key;
      existing.items.push(renamed);
    } else if (pair === undefined) existing.items.push(document.createPair(key, wanted));
    else pair.value = reconcile(document, pair.value, wanted);
  }
  existing.items = inOrderOf(document, Object.keys(value), existing.items);
}

/** The first pair of `gone` with a plain key that holds `wanted`, taken out of `gone`. */
function renamedPair<Item extends { key: unknown; value: unknown }>(
  document: Document,
  gone: Item[],
  wanted: unknown,
): Item | undefined {
  const at = gone.findIndex(
    (pair) =>
      isScalar(pair.key) &&
      // A key another refers to by its anchor would change what that one reads.
      pair.key.anchor === undefined &&
      sameValue(document, pair.value, wanted),
  );
  return at === -1 ? undefined : gone.splice(at, 1)[0];
}

/**
 * Pairs sorted into `order`. A key like `2024` stays where it was: a
 * JavaScript object lists such keys first whatever order they were written
 * in, so its place in `order` says nothing about where it belongs.
 */
function inOrderOf<Item extends { key: unknown }>(
  document: Document,
  order: readonly string[],
  items: Item[],
): Item[] {
  const nameOf = (item: Item) => keyOf(item.key, document);
  const place = new Map(order.filter((key) => !isIndexKey(key)).map((key, at) => [key, at]));
  const movable = items
    .filter((item) => place.has(nameOf(item)))
    .sort((left, right) => (place.get(nameOf(left)) ?? 0) - (place.get(nameOf(right)) ?? 0));
  let next = 0;
  return items.map((item) => (place.has(nameOf(item)) ? (movable[next++] as Item) : item));
}

const isIndexKey = (key: string) => /^(?:0|[1-9]\d{0,8})$/.test(key);

function sameValue(document: Document, node: unknown, value: unknown): boolean {
  const current: unknown = isNode(node) ? (node as Node).toJS(document) : node;
  return readsTheSame(current, value);
}

/**
 * Whether two values read the same. One that refers to itself — `&e` holding
 * `*e`, or a JavaScript object cycle — has no JSON form, and is compared
 * shape by shape instead, so writing it back unchanged leaves it alone.
 */
function readsTheSame(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    // JSON.stringify throws only on a cycle (or a BigInt, which YAML never reads as).
    return sameShape(left, right, new Map());
  }
}

/**
 * JSON's equality — same keys in the same order, same values — that follows
 * a cycle: a pair of objects already being compared counts as the same.
 * Every pair is remembered, not one partner per object, since cycles of
 * different lengths (`x = [x]` against `y = [[y]]`) pair one object with
 * several and would otherwise alternate for ever.
 */
function sameShape(left: unknown, right: unknown, comparing: Map<object, Set<object>>): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  const partners = comparing.get(left) ?? new Set<object>();
  if (partners.has(right)) return true;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  comparing.set(left, partners.add(right));
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  const at = (value: object, key: string) => (value as Record<string, unknown>)[key];
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameShape(at(left, key), at(right, key), comparing),
    )
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScalarValue = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** A block's top-level keys, each with the exact text that writes it. */
interface Segments {
  /** Comments and blank lines before the first key. */
  readonly head: string;
  /** The spaces the keys' lines start with; YAML has every top-level key share them. */
  readonly indent: string;
  /** Each key's name, its {@link idOf} id, its text, and the comment lines that open it. */
  readonly keys: readonly {
    readonly key: string;
    readonly id: string;
    readonly text: string;
    readonly above: string;
    /**
     * The key's text cut where its value ends: the key and value lines up to
     * the value's last character, the rest of that line (spaces, an inline
     * comment, the newline), and the lines below it the key's text holds.
     * `block` is a value written in block style, whose rest is its last
     * item's. Null when where the value ends cannot be told.
     */
    readonly value: {
      readonly lines: string;
      readonly rest: string;
      readonly inline: boolean;
      readonly block: boolean;
      /** The column a line below would be read as the value's text from (its last block scalar's); 0 for any line. */
      readonly joins: number | null;
      readonly below: string;
    } | null;
    /** Whether the value is a map written in block style, whose entries can be kept one by one. */
    readonly map: boolean;
  }[];
  /** Whatever follows the last key's value: a trailing comment. */
  readonly tail: string;
}

/**
 * The block as written, with every key that was not touched put back as the
 * text it was found as. Each key's text runs from the comment lines right
 * above it to where the next key's begin, so a key's comment goes where the
 * key goes. Both texts are cut the same way, which is what lets a key's
 * written text be swapped for its original. A trailing comment is kept as it
 * was found.
 *
 * The library writes every key at column 0, so a key it wrote is put at the
 * block's own indent, under the comment lines the original key had — those
 * keep their own columns, as every line the change did not reach does. A key
 * given as written is moved from the column it was written at to the block's.
 */
function keepUntouched({
  before,
  written,
  edit,
  rules,
}: {
  /** The original block, cut by {@link segments}. */
  before: Segments | null;
  written: string;
  edit: Edit;
  rules: Rules;
}): {
  text: string;
  /** Of the pairs whose comments below were cleared, those not written back under them. */
  unplaced: string[];
} {
  const unplaced = [...edit.cleared.keys()];
  const after = segments(written);
  if (after === null) return { text: written, unplaced };
  if (before === null) return { text: givenAsWritten(after, edit.asWritten) ?? written, unplaced };
  const placed = new Set<string>();
  const found = new Map(before.keys.map((segment) => [segment.id, segment]));
  const indent = before.indent.length;
  let carried = '';
  const keys = after.keys.map((segment) => {
    const given = edit.asWritten.get(segment.id);
    if (given !== undefined) return shifted(given, indent - keyColumnOf(given));
    const original = found.get(segment.id);
    if (original === undefined) return shifted(segment.text, indent);
    if (!edit.touched.has(segment.id)) return original.text;
    const cleared = rules === 'kept' && edit.cleared.has(segment.id);
    const kept = valueKept({ original, segment, indent, rules, cleared });
    if (kept !== null) {
      placed.add(segment.id);
      return kept;
    }
    const text = `${original.above}${shifted(segment.text.slice(segment.above.length), indent)}`;
    if (original === before.keys.at(-1)) carried = carriedBelow(original, text, after, indent);
    return text;
  });
  // The head is comments and blank lines no key owns: no change reaches them.
  // #395's rules end the block where main did, without the blank lines a
  // kept-trailing-lines value would read as its own.
  const tail = rules === 'main' ? before.tail.replace(/\n(?:[ \t]*\n)*$/, '\n') : before.tail;
  const text = `${keys.join('')}${carried}${tail}`;
  const more = tail === '' && carried === '' && keepsLastLine(text, after) ? '\n' : '';
  return {
    text: `${before.head}${text}${more}`.replace(/\n$/, ''),
    unplaced: unplaced.filter((id) => !placed.has(id)),
  };
}

/**
 * Whether the block's keys end in a blank line that a kept-trailing-lines
 * (`|+`) value holds — one moved to the end by a key removed after it. The
 * reader drops the newline before the closing line, so the block needs one
 * more for the value to keep its own.
 */
function keepsLastLine(text: string, after: Segments): boolean {
  return text.endsWith('\n\n') && after.keys.at(-1)?.value?.joins === 0;
}

/**
 * The comment lines under the block's last key, when the library wrote that
 * key's text: they go after every key, as the block's tail does, where the
 * last key written would not read them as its text, and the library did
 * not write them itself or a key added after it stands between. Empty
 * otherwise.
 */
function carriedBelow(
  original: Segments['keys'][number],
  text: string,
  after: Segments,
  indent: number,
): string {
  const below = original.value?.below ?? '';
  const comments = below.split('\n').filter((line) => /^ *#/.test(line));
  // A key added after it ends the value, and so where the library put them.
  const added = after.keys.at(-1)?.id !== original.id;
  if (comments.length === 0) return '';
  if (!added && comments.some((line) => text.includes(line.trim()))) return '';
  const joins = after.keys.at(-1)?.value?.joins ?? null;
  return readAsText(below, joins === null ? null : joins + indent) ? '' : below;
}

/** How a touched key is written: #430's rules, or #395's (a one-line value only). */
type Rules = 'kept' | 'main';

/** With nothing of the original to keep, the written block with keys given as written so; null with none. */
function givenAsWritten(after: Segments, asWritten: ReadonlyMap<string, string>): string | null {
  if (asWritten.size === 0) return null;
  const keys = after.keys.map((segment) => {
    const given = asWritten.get(segment.id);
    return given === undefined ? segment.text : shifted(given, -keyColumnOf(given));
  });
  return `${after.head}${keys.join('')}${after.tail}`.replace(/\n$/, '');
}

/**
 * A touched key's text with only its value the library's: what stood after
 * the value on its line and the lines under it are the original's. The
 * library reads a comment under a value as the value's own, the field an
 * inline comment uses, and writes it inline or under the value's last item
 * (#395, #430). Null when the key's text must be the library's.
 */
function valueKept({
  original,
  segment,
  indent,
  rules,
  cleared,
}: {
  original: Segments['keys'][number];
  segment: Segments['keys'][number];
  indent: number;
  rules: Rules;
  /** The comments below the value were taken off it before writing. */
  cleared: boolean;
}): string | null {
  const was = original.value;
  const now = segment.value;
  if (was === null || now === null) return null;
  if (rules === 'main') {
    if (was.block || was.inline || now.block) return null;
    return `${original.above}${shifted(now.lines, indent)}\n${was.below}`;
  }
  if (!now.block) {
    return `${original.above}${shifted(now.lines, indent)}${was.block ? '\n' : was.rest}${was.below}`;
  }
  // A value written in blocks holds what is left of the comments it had —
  // its last item's own — so it is the library's only once the ones below
  // it were taken off; an inline comment has no line left to stand on, and
  // a line below that its last block of text would read as its own stays
  // with the library. A comment line the new value ends with that was not
  // under the old one — one under an entry moved to the end of a map — is
  // the value's own, and stays above those.
  const joins = now.joins === null ? null : now.joins + indent;
  if ((!was.block && was.inline) || !cleared || readAsText(was.below, joins)) return null;
  const own = shifted(commentLinesNotIn(now.below, was.below), indent);
  const value = withColumnsOf(
    withoutTrailingSpace(shifted(`${now.lines}${now.rest}`, indent)),
    was.lines,
  );
  return `${original.above}${value}${own}${was.below}`;
}

/** The comment lines of `text` saying what none of `other`'s comments do. */
function commentLinesNotIn(text: string, other: string): string {
  const said = new Set(commentsOf(other));
  return text
    .split('\n')
    .filter((line) => /^ *#/.test(line) && !said.has(commentsOf(line)[0] ?? ''))
    .map((line) => `${line}\n`)
    .join('');
}

/** An empty item the library writes as `- ` (or `- &anchor `) without the space it leaves after it. */
const withoutTrailingSpace = (written: string) => written.replace(/^( *-(?: &\S+)?) +$/gm, '$1');

/**
 * `written` with each comment line it shares with `original` — the same
 * text, once in each — at the column it had there: the library writes a
 * comment between items at the items' column, wherever it was.
 */
function withColumnsOf(written: string, original: string): string {
  const comments = (text: string) => text.split('\n').filter((line) => /^ *#/.test(line));
  const had = comments(original);
  const has = comments(written);
  const once = (lines: string[], line: string) =>
    lines.filter((other) => other.trimStart() === line.trimStart()).length === 1;
  return written
    .split('\n')
    .map((line) => {
      if (!/^ *#/.test(line) || !once(has, line) || !once(had, line)) return line;
      return had.find((other) => other.trimStart() === line.trimStart()) as string;
    })
    .join('\n');
}

/**
 * Whether lines put under a value ending in a block scalar would be read as
 * its text: a line at `joins` or deeper, not an empty one (YAML's
 * l-empty), before any shallower line; any line at all when the scalar
 * keeps its trailing lines (`joins` 0). Null `joins`: none would.
 */
function readAsText(below: string, joins: number | null): boolean {
  if (joins === null) return false;
  if (joins === 0) return below !== '';
  for (const line of below.split('\n')) {
    if (emptyUnder(line, joins)) continue;
    // From a comment shallower than the text on, every comment line is one (l-trail-comments).
    if (columnOfText(line) < joins) return false;
    return true;
  }
  return false;
}

/**
 * Whether `line` is an empty line to a block scalar whose text is at
 * `column`: spaces no deeper than it. Spaces past it, or a tab, are text.
 */
const emptyUnder = (line: string, column: number) => /^ *$/.test(line) && line.length <= column;

/** The column a line's text starts at; a whitespace-only line's length. */
const columnOfText = (line: string) => /^ */.exec(line)?.[0].length ?? 0;

/**
 * `written` with the entries of each changed map that the change did not
 * reach put back as the text they were found as (#697): moving, adding,
 * removing or renaming one property of a type keeps every other one's
 * spacing, padding and comments, at any depth. An entry is untouched when
 * the library writes it the same before and after the change — the one test
 * that sees every way a change can reach it, an anchor taken off included.
 * Every other entry is the library's, at the columns the map was found at.
 * A key the change gives as written, or a map whose comments would not come
 * out the same, is written whole, as it always was.
 */
function withEntriesKept({
  written,
  found,
  before,
  edit,
}: {
  written: string;
  /** The block as the library wrote it before the change; null keeps nothing. */
  found: string | null;
  before: Segments | null;
  edit: Edit;
}): string {
  const after = found === null || before === null ? null : segments(written);
  const was = found === null ? null : segments(found);
  if (after === null || was === null || before === null) return written;
  const rendered = new Map(was.keys.map((segment) => [segment.id, entryOf(segment)]));
  const original = new Map(before.keys.map((segment) => [segment.id, entryOf(segment)]));
  const keys = after.keys.map((segment) => {
    const render = rendered.get(segment.id);
    const found = original.get(segment.id);
    if (!edit.touched.has(segment.id) || edit.asWritten.has(segment.id)) return segment.text;
    if (render === undefined || found === undefined) return segment.text;
    // The library writes keys at column 0; keepUntouched moves the text to the block's.
    const kept = entryKept(entryOf(segment), render, rebased(found, before.indent.length), 'line');
    return kept ?? segment.text;
  });
  return `${after.head}${keys.join('')}${after.tail}`.replace(/\n$/, '');
}

/** One entry of a map, cut by {@link segments}. */
interface Entry {
  readonly id: string;
  readonly text: string;
  readonly above: string;
  readonly map: boolean;
  /** Whether blank lines at its end are its value's own text (a block scalar keeping its trailing lines), not the map's. */
  readonly holdsBlanks: boolean;
}

const entryOf = (segment: Segments['keys'][number]): Entry => ({
  id: segment.id,
  text: segment.text,
  above: segment.above,
  map: segment.map,
  holdsBlanks: segment.value === null || segment.value.joins === 0,
});

/** `entry` moved left `by` columns. */
const rebased = (entry: Entry, by: number): Entry => ({
  ...entry,
  text: shifted(entry.text, -by),
  above: shifted(entry.above, -by),
});

/**
 * A changed entry whose value is a block map, its head and each entry under
 * it kept as `source` has them wherever the library writes them the same
 * before (`render`) and after (`written`) the change. `keep` says how much
 * of its head may be the source's: the comments above it and its key line,
 * or (for a block's own keys, whose comments above keepUntouched places)
 * only the key line. Null when it cannot be cut so.
 */
function entryKept(
  written: Entry,
  render: Entry,
  source: Entry,
  keep: 'head' | 'line',
): string | null {
  if (!written.map || !render.map || !source.map) return null;
  const now = headAndBody(written);
  const then = headAndBody(render);
  const found = headAndBody(source);
  if (now === null || then === null || found === null) return null;
  const by = keyColumnOf(source.text) - keyColumnOf(written.text);
  // A key line holding an anchor or tag is written by the library with those
  // under it, so only one holding neither is the same line in the source.
  const line = then.line === now.line && !holdsProperties(found.line) ? found.line : null;
  const lead = sharedLead({ now, then, found, keyLineKept: line !== null });
  const body = mapKept(
    lead?.bodies ?? { written: now.body, render: then.body, source: found.body },
  );
  if (body === null) return null;
  const above =
    keep === 'line'
      ? now.above
      : partKept({ now: now.above, then: then.above, found: found.above, by });
  return `${above}${line ?? shifted(now.line, by)}${lead?.text ?? ''}${body}`;
}

/** An entry's comments above, its key's line, and the lines of its value under it. */
function headAndBody(entry: Entry): { above: string; line: string; body: string } | null {
  const ends = entry.text.indexOf('\n', entry.above.length);
  if (ends === -1) return null;
  return {
    above: entry.above,
    line: entry.text.slice(entry.above.length, ends + 1),
    body: entry.text.slice(ends + 1),
  };
}

type HeadAndBody = NonNullable<ReturnType<typeof headAndBody>>;

/**
 * The comment lines a map opens with, as the source has them, when the
 * library writes the same ones at its top before and after the change. Those
 * are the map's own — its key line's comment, or the comments over its first
 * entry, which the library reads as the map's — and stay at its top whichever
 * entry comes first. With them, the three bodies below them. Null when there
 * are none, or the source's are not the same comments.
 */
function sharedLead({
  now,
  then,
  found,
  keyLineKept,
}: {
  now: HeadAndBody;
  then: HeadAndBody;
  found: HeadAndBody;
  /** The source's key line is written: a comment on it is not the lead's to write. */
  keyLineKept: boolean;
}): { text: string; bodies: { written: string; render: string; source: string } } | null {
  // The map's own comments open it before the change; after it, the new
  // first entry's own may follow them.
  const written = leadOf(then.body);
  if (written === '' || !now.body.startsWith(written)) return null;
  const text = leadOf(found.body);
  // The library writes a key line's comment above the map's first entry.
  const held = keyLineKept && commentsOf(then.line).length === 0 ? `${found.line}${text}` : text;
  if (!sameComments(written, held)) return null;
  return {
    text,
    bodies: {
      written: now.body.slice(written.length),
      render: then.body.slice(written.length),
      source: found.body.slice(text.length),
    },
  };
}

/** The lines a map's body opens with up to its last comment line before its first key; blank lines below that are its first entry's. */
function leadOf(body: string): string {
  return /^(?:[ \t]*(?:#.*)?\n)*[ \t]*#.*\n/.exec(body)?.[0] ?? '';
}

/**
 * A map's lines before or after its entries, or the comments above one: the
 * source's when the library writes the same there before and after the
 * change, and they are only comments and blank lines — an anchor or tag the
 * library writes on a line of its own is never the source's to drop.
 * Otherwise the library's, at the source's columns.
 */
function partKept({
  now,
  then,
  found,
  by,
}: {
  now: string;
  then: string;
  found: string;
  by: number;
}) {
  return now === then && /^(?:[ \t]*(?:#.*)?\n)*$/.test(now) ? found : shifted(now, by);
}

/**
 * A block map's lines, `written` by the library after the change, with each
 * entry it wrote as it wrote `render` before the change put back as
 * `source` holds it, and the rest moved to `source`'s columns. Null when one
 * of them is not a block map that can be cut into entries.
 */
function mapKept({
  written,
  render,
  source,
}: {
  written: string;
  render: string;
  source: string;
}): string | null {
  const now = entriesOf(written);
  const then = entriesOf(render);
  const found = entriesOf(source);
  if (now === null || then === null || found === null) return null;
  const rendered = new Map(then.entries.map((entry) => [entry.id, entry]));
  const original = new Map(found.entries.map((entry) => [entry.id, entry]));
  const by = found.indent - now.indent;
  const entryText = (entry: Entry) => {
    const render = rendered.get(entry.id);
    const source = original.get(entry.id);
    if (render === undefined || source === undefined) return shifted(entry.text, by);
    // The blank lines above it are where the library put them; the source's go with it.
    if (withoutLeadingBlanks(render.text) === withoutLeadingBlanks(entry.text)) return source.text;
    return entryKept(entry, render, source, 'head') ?? shifted(entry.text, by);
  };
  const entries = now.entries.map((entry, at) => {
    const text = entryText(entry);
    // Blank lines under text that keeps its trailing lines (`|+`) would be
    // read as that text: the library's, none, stand there.
    if (now.entries[at - 1]?.holdsBlanks !== true) return text;
    return `${leadingBlanks(entry.text)}${withoutLeadingBlanks(text)}`;
  });
  const head = partKept({ now: now.head, then: then.head, found: found.head, by });
  const tail = partKept({ now: now.tail, then: then.tail, found: found.tail, by });
  // Each part ends in a newline; the last one's is the one the text was cut without.
  const text = `${head}${entries.join('')}${tail}`.replace(/\n$/, '');
  return `${text}${written.endsWith('\n') ? '\n' : ''}`;
}

const withoutLeadingBlanks = (text: string) => text.replace(/^(?:[ \t]*\n)+/, '');

const leadingBlanks = (text: string) => /^(?:[ \t]*\n)*/.exec(text)?.[0] ?? '';

/**
 * A map's entries, each holding the blank lines above it rather than
 * {@link segments}' lines below the one before: the library writes a blank
 * line with the key it stands above, so that is where it moves when the
 * entries do. Blank lines a block scalar keeping its trailing lines (`|+`)
 * ends in are its text, and stay with it.
 */
function entriesOf(
  text: string,
): { head: string; indent: number; entries: Entry[]; tail: string } | null {
  const cut = segments(text.replace(/\n$/, ''));
  if (cut === null) return null;
  let carried = '';
  const entries = cut.keys.map((segment) => {
    const entry = entryOf(segment);
    const blanks = entry.holdsBlanks ? null : /\n((?:[ \t]*\n)+)$/.exec(entry.text);
    const own = blanks === null ? entry.text : entry.text.slice(0, blanks.index + 1);
    const moved = { ...entry, text: `${carried}${own}`, above: `${carried}${entry.above}` };
    carried = blanks?.[1] ?? '';
    return moved;
  });
  const last = entries.at(-1);
  // segments ends the last key's text above blank lines; one that keeps its trailing lines holds them.
  const held = last?.holdsBlanks === true ? (/^(?:[ \t]*\n)*/.exec(cut.tail)?.[0] ?? '') : '';
  if (last !== undefined && held !== '')
    entries[entries.length - 1] = { ...last, text: `${last.text}${held}` };
  const tail = `${carried}${cut.tail.slice(held.length)}`;
  return { head: cut.head, indent: cut.indent.length, entries, tail };
}

/** Whether two texts hold the same comments, each as often: none lost, none written twice. */
function sameComments(left: string, right: string): boolean {
  return JSON.stringify(commentsOf(left).sort()) === JSON.stringify(commentsOf(right).sort());
}

/** Whether a line gives a node an anchor or a tag. */
const holdsProperties = (line: string) =>
  [...new Lexer().lex(line)].some((token) => token.startsWith('&') || token.startsWith('!'));

/** The comments a text holds, as YAML reads them: never a `#` inside quotes. */
const commentsOf = (text: string) =>
  [...new Lexer().lex(text)].filter((token) => token.startsWith('#'));

function segments(text: string): Segments | null {
  // The text is lines without the last one's newline: a newline it ends with
  // is a blank line, the tail's to keep (#430).
  const source = `${text}\n`;
  const document = parseDocument(source);
  const contents = document.contents;
  // A flow map (`{title: Plan}`) holds its keys on shared lines, so it cannot
  // be cut into one run of lines per key; the library writes it back whole,
  // in its own flow style, which leaves an untouched key as it was.
  if (!isMap(contents) || contents.flow === true || contents.items.length === 0) return null;
  const lines: number[] = [];
  for (const pair of contents.items) {
    if (!isNode(pair.key) || pair.key.range === undefined || pair.key.range === null) return null;
    lines.push(source.lastIndexOf('\n', pair.key.range[0] - 1) + 1);
  }
  const indent = /^ */.exec(source.slice(lines[0]))?.[0] ?? '';
  const starts = lines.map((line) => withCommentsAbove(source, line, indent.length));
  const last = contents.items[contents.items.length - 1] as Pair;
  // The newline added above is no line of the text's: nothing ends past it.
  const limit = text.endsWith('\n') ? text.length : source.length;
  const end = Math.min(lastKeyEnd(source, last, indent.length), limit);
  const seen = new Map<string, number>();
  const keys = contents.items.map((pair, at) => {
    const key = keyOf(pair.key, document);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const ends = starts[at + 1] ?? end;
    return {
      key,
      id: idOf(key, occurrence),
      text: source.slice(starts[at], ends),
      above: source.slice(starts[at], lines[at]),
      value: valueLines(source, pair.value, { from: lines[at] as number, to: ends }),
      map: isBlockMap(pair.value),
    };
  });
  return { head: source.slice(0, starts[0]), indent, keys, tail: source.slice(end) };
}

/**
 * Where the last key's text ends: past its value and the comment lines
 * deeper than the keys under it (and blank lines among them), as every
 * other key's text runs on to the next key. A comment no deeper than the
 * keys, and blank lines after the last deep comment, end the block.
 */
function lastKeyEnd(source: string, last: Pair, indent: number): number {
  let end = lineEnd(source, isNode(last.value) ? last.value.range : (last.key as Node).range);
  for (let at = end; at < source.length;) {
    const next = source.indexOf('\n', at) + 1 || source.length;
    const line = source.slice(at, next).replace(/\n$/, '');
    if (/^ *#/.test(line) && columnOfText(line) > indent) end = next;
    else if (line.trim() !== '') break;
    at = next;
  }
  return end;
}

/** A key's {@link Segments} `value`, for the key's text between `from` and `to`. */
function valueLines(
  source: string,
  value: unknown,
  { from, to }: { from: number; to: number },
): Segments['keys'][number]['value'] {
  const end = isNode(value) ? valueEnd(source, value) : null;
  // A value's range may run into the newline added past the text: it ends with the text.
  const at = end === null ? null : Math.min(end.at, to);
  if (end === null || at === null || at < from) return null;
  const lineEnds = Math.min(lineEnd(source, [at, at, at]), to);
  const rest = source.slice(at, lineEnds);
  return {
    lines: source.slice(from, at),
    rest,
    inline: rest.trim() !== '',
    block: !endsOnItsOwnLine(value as Node),
    joins: end.joins,
    below: source.slice(lineEnds, to),
  };
}

/** A scalar not in block style, or a flow list or map: a value whose line ends where it does. */
function endsOnItsOwnLine(value: Node): boolean {
  return (
    (isScalar(value) && value.type !== 'BLOCK_LITERAL' && value.type !== 'BLOCK_FOLDED') ||
    isAlias(value) ||
    ((isMap(value) || isSeq(value)) && value.flow === true)
  );
}

/**
 * Where a value's own text ends: the end of the last scalar, alias or flow
 * collection in it — a block list's or map's range runs on over the comment
 * lines under it, as a block scalar's does over the shallower ones. With it,
 * the column from which a line put below would be read as the value's text,
 * when it ends in a block scalar. Null when the end cannot be told.
 */
function valueEnd(source: string, value: Node): { at: number; joins: number | null } | null {
  let end: { at: number; joins: number | null } | null = null;
  let unknown = false;
  const reach = (node: Node) => {
    const reached = isBlockScalar(node)
      ? blockScalarEnd(source, node as Scalar)
      : node.range
        ? { at: node.range[1], joins: null }
        : null;
    if (reached === null) unknown = true;
    else if (end === null || reached.at > end.at) end = reached;
  };
  const reachable = (node: Node) => isScalar(node) || endsOnItsOwnLine(node);
  if (reachable(value)) reach(value);
  else {
    visit(value, {
      Node: (_, node) => {
        if (!reachable(node)) return undefined;
        reach(node);
        return visit.SKIP;
      },
    });
  }
  return unknown ? null : end;
}

const isBlockScalar = (node: Node) =>
  isScalar(node) && (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED');

/**
 * Where a block scalar's text ends — short of the comment lines shallower
 * than its text and, unless it keeps them (`|+`), the empty lines its range
 * runs on over — and the column its text is at. Null for one with an explicit
 * indent, or no text to tell the column by.
 */
function blockScalarEnd(source: string, node: Scalar): { at: number; joins: number } | null {
  if (node.range === undefined || node.range === null) return null;
  const [start, stop] = node.range;
  const headerEnds = source.indexOf('\n', start);
  const header = source.slice(start, headerEnds === -1 ? stop : headerEnds).replace(/#.*/, '');
  if (headerEnds === -1 || headerEnds >= stop || /\d/.test(header)) return null;
  const keeps = header.includes('+');
  const lines = source.slice(headerEnds + 1, stop).split('\n');
  const first = lines.find((line) => line.trim() !== '');
  if (first === undefined) return null;
  const column = columnOfText(first);
  // The first line shallower than the text, not an empty one, starts the
  // comments that end the scalar (l-trail-comments): every line after it is
  // one, however deep. Empty lines before it are the scalar's only if kept.
  let ends = lines.findIndex((line) => !emptyUnder(line, column) && columnOfText(line) < column);
  if (ends === -1) ends = lines.length;
  if (!keeps) while (ends > 0 && emptyUnder(lines[ends - 1] as string, column)) ends -= 1;
  const at = Math.min(
    stop,
    headerEnds + 1 + lines.slice(0, ends).reduce((sum, line) => sum + line.length + 1, 0),
  );
  return { at, joins: keeps ? 0 : column };
}

/**
 * Takes the comment lines under `key`'s value, as it was found, off the nodes
 * of its new value that still hold them, so the library does not write them
 * into the value it writes (#430); they are written back as they were found,
 * under it. Returns how to put them back, when none of its nodes holds them
 * or the ones that do are each inside the last and hold them at the ends of
 * their comments; null, leaving the nodes alone, for anything else.
 */
function clearCommentBelow(
  document: Document,
  key: string,
  before: Segments | null,
): (() => void) | null {
  const pair = pairOf(document, key);
  const keys = before?.keys ?? [];
  const at = keys.findIndex(
    (segment) => segment.id === idOf(key, pairsOf(document, key).length - 1),
  );
  const found = keys[at];
  if (before === null || pair === undefined || found === undefined || found.value === null) {
    return null;
  }
  if (!found.value.block && found.value.inline) return null;
  const below = `${found.value.below}${at === before.keys.length - 1 ? before.tail : ''}`;
  // The library may hold the next key's comment lines with these, at the end
  // of the same comment; they are that key's to write.
  const lines = `${below}${keys[at + 1]?.above ?? ''}`;
  const said = commentSaid(lines);
  if (said.length === 0) return () => undefined;
  const holders = commentHolders(pair, lines);
  if (holders === null) return null;
  if (holders.length === 0) return () => undefined;
  const own = /^\s*#(.*)$/.exec(found.value.rest.replace(/\n$/, ''))?.[1] ?? '';
  return takeOff(holders, said, own);
}

/**
 * The nodes of `pair` whose comments say any of the comment lines in
 * `lines` (a bare `#` says what any comment does), the deepest first; none
 * when the library holds them elsewhere — a block scalar's go above the next
 * key. Null unless each is inside the one after it, holding them after its
 * own text: a comment above a node, or nodes side by side, cannot be told
 * apart from the value's own comments.
 */
function commentHolders(pair: Pair, lines: string): Node[] | null {
  const texts = commentSaid(
    lines
      .split('\n')
      .filter((line) => /^ *#/.test(line))
      .join('\n'),
  );
  const says = (comment: string | null | undefined) =>
    typeof comment === 'string' &&
    texts.some((text) => text.trim() === '' || comment.includes(text));
  const mentions: { node: Node; path: readonly unknown[] }[] = [];
  for (const side of [pair.key, pair.value]) {
    if (!isNode(side)) continue;
    visit(side, {
      Node: (_, node, path) => {
        if (says(node.comment) || says(node.commentBefore)) mentions.push({ node, path });
      },
    });
  }
  const nested = mentions.every(
    ({ node, path }, index) =>
      !says(node.commentBefore) &&
      (index === 0 || path.includes((mentions[index - 1] as { node: Node }).node)),
  );
  return nested ? mentions.map(({ node }) => node).reverse() : null;
}

/**
 * The lines from the first comment line in `below` to the last, as the
 * library holds them in a comment: each comment line's text after its `#`,
 * a blank line as an empty one.
 */
function commentSaid(below: string): string[] {
  const lines = below.split('\n');
  const first = lines.findIndex((line) => /^ *#/.test(line));
  if (first === -1) return [];
  const last = lines.findLastIndex((line) => /^ *#/.test(line));
  return lines.slice(first, last + 1).map((line) => line.replace(/^ *#?/, ''));
}

/**
 * Takes `said` off the ends of the comments of `nodes`, the deepest first:
 * each takes the first run of the lines left that its comment ends with —
 * lines before it were held by nodes the change took out — leaving nothing
 * of it or, the deepest only, `own`: the inline comment on the line the
 * value ends on. Lines left over are held outside the value (the next key's
 * comment above it). Null, with every node as it was, when a node's comment
 * does not end so.
 */
function takeOff(
  nodes: readonly Node[],
  said: readonly string[],
  own: string,
): (() => void) | null {
  const kept = nodes.map((node) => node.comment);
  const putBack = () => nodes.forEach((node, index) => (node.comment = kept[index] ?? null));
  let from = 0;
  for (const [index, node] of nodes.entries()) {
    const run = runTaken(node.comment ?? '', said, from, index === 0 ? own : '');
    if (run === null) {
      putBack();
      return null;
    }
    node.comment = run.rest === '' ? null : run.rest;
    from = run.to;
  }
  return putBack;
}

/**
 * The first run of `said` from `from` on that `comment` ends with, leaving
 * `rest` — nothing, or `own` — before it on lines of its own; null for none.
 */
function runTaken(
  comment: string,
  said: readonly string[],
  from: number,
  own: string,
): { to: number; rest: string } | null {
  // Blank lines after the comment's last line are the ones under it, kept with it.
  const text = comment.replace(/\n+$/, '');
  for (let start = from; start < said.length; start++) {
    if (said[start] === '') continue;
    for (let to = said.length; to > start; to--) {
      const run = said.slice(start, to).join('\n');
      if (!text.endsWith(run)) continue;
      const left = text.slice(0, text.length - run.length);
      const rest = left.replace(/\n+$/, '');
      if ((left === '' || left.endsWith('\n')) && (rest === '' || rest === own))
        return { to, rest };
    }
  }
  return null;
}

/**
 * Where a key's line starts, moved up over the comment lines that open it: of
 * the comment lines directly above it, the ones from the first that is no
 * deeper than the keys. As the library reads them, comments deeper than the
 * keys before that one end the value above (or head the block); every comment
 * from it on belongs to the key below, whatever its column.
 */
function withCommentsAbove(source: string, lineStart: number, indent: number): number {
  let start = lineStart;
  let opens = lineStart;
  while (start > 0) {
    const previous = source.lastIndexOf('\n', start - 2) + 1;
    const comment = /^( *)#/.exec(source.slice(previous, start));
    if (comment === null) break;
    start = previous;
    if ((comment[1]?.length ?? 0) <= indent) opens = start;
  }
  return opens;
}

/** The column a key's text writes its key at: its first line that is neither blank nor a comment. */
function keyColumnOf(text: string): number {
  const line = /^(?! *(?:#|$))( *)/m.exec(text);
  return line?.[1]?.length ?? 0;
}

/**
 * Text moved `by` columns: right by prefixing every non-empty line, left by
 * taking up to that many leading spaces off each — a comment standing left of
 * the key keeps what it has. Moving a key's text by the difference between
 * two indents writes it at the other, its lines still deep as they were.
 */
function shifted(text: string, by: number): string {
  if (by > 0) return text.replace(/^(?=.)/gm, ' '.repeat(by));
  if (by < 0) return text.replace(new RegExp(`^ {1,${-by}}`, 'gm'), '');
  return text;
}

/** Just past the newline that ends a node's value (and its comment on the same line). */
export function lineEnd(source: string, range: Node['range'] | undefined): number {
  const at = range?.[1] ?? source.length;
  if (source[at - 1] === '\n') return at;
  const newline = source.indexOf('\n', at);
  return newline === -1 ? source.length : newline + 1;
}

const DEFAULT_OPENING = '---\n';
const DEFAULT_CLOSING = '---\n';

export function split(frontmatter: string | null): {
  opening: string;
  body: string;
  closing: string;
  /** Every line between the delimiters, the last one's newline included; `body` is this without it. */
  content: string;
} {
  if (frontmatter === null) {
    return { opening: DEFAULT_OPENING, body: '', closing: DEFAULT_CLOSING, content: '' };
  }

  // A byte-order mark before the block is part of its opening, written back as found.
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(frontmatter);
  const closing = /\r?\n---[ \t]*(\r?\n)?$/.exec(frontmatter);
  if (opening === null || closing === null) {
    return { opening: DEFAULT_OPENING, body: '', closing: DEFAULT_CLOSING, content: '' };
  }

  const start = opening[0].length;
  const closingLine = frontmatter.slice(closing.index);
  const lastNewline = /^\r?\n/.exec(closingLine)?.[0] ?? '';
  return {
    opening: opening[0],
    body: frontmatter.slice(start, closing.index),
    closing: closingLine.slice(lastNewline.length),
    // `---\n---\n` holds no lines: the closing's newline is the opening's own.
    content: closing.index < start ? '' : frontmatter.slice(start, closing.index) + lastNewline,
  };
}
