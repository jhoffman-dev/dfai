/**
 * Attack on PR #687 (#683): a type now loads without a property it cannot read,
 * and the sidebar says so — which invites the person to make that property
 * again in the type editor, under the same name. The editor's write works the
 * file's `properties` out against the keys it read, and a key it skipped is
 * not among them, so a property given that key is mis-placed in the rebuild.
 */
import { describe, expect, it } from 'vitest';
import { parseObjectType } from './property-def.ts';
import { addProperty, moveProperty, renameProperty, TypeEditError } from './type-edit.ts';
import { typeFrontmatterChanges } from './type-frontmatter.ts';

/** A Book type as typed by hand: `author` has a typo (`targets:`), so it is skipped and listed as broken. */
const WRITTEN = {
  name: 'book',
  label: 'Book',
  properties: {
    rating: 'number',
    author: { kind: 'relation', targets: 'person', hint: 'who wrote it' },
    pages: 'number',
  },
};
const before = parseObjectType(WRITTEN);

/** The `properties` map the edit writes, and the type that file then reads as. */
function written(after: ReturnType<typeof parseObjectType>) {
  const changes = typeFrontmatterChanges({ before, after, written: WRITTEN });
  const properties = (changes['properties'] ?? WRITTEN.properties) as Record<string, unknown>;
  return { properties, reread: parseObjectType({ ...WRITTEN, properties }) };
}

describe('editing a type beside a property it skipped (attack #687)', () => {
  // Fixed in #683 by keeping the file's skipped keys out of the editor's: a new
  // property gets a key of its own, and a rename onto a skipped key is refused.
  it('reads author as skipped, and the editor keeps its key for the file', () => {
    expect(before.properties.map((property) => property.key)).toEqual(['rating', 'pages']);
    expect(before.unreadKeys).toEqual(['author']);
    expect(addProperty(before, { label: 'Author', kind: 'text' }).properties.at(-1)?.key).not.toBe(
      'author',
    );
  });

  it('a property added beside a skipped one of its name is written to the file', () => {
    const after = addProperty(before, { label: 'Author', kind: 'text' });
    expect(written(after).reread.properties.map((property) => property.label)).toContain('Author');
    // And what the file said of the skipped one is still there, as it was.
    expect(written(after).properties['author']).toEqual(WRITTEN.properties.author);
  });

  it('moving such a property to the top keeps every valid property in the file', () => {
    const added = addProperty(before, { label: 'Author', kind: 'text' });
    const key = added.properties.at(-1)?.key ?? '';
    const after = moveProperty(added, { key, to: 0 });
    expect(Object.keys(written(after).properties)).toEqual(
      expect.arrayContaining(['rating', 'author', 'pages', key]),
    );
    expect(written(after).properties['pages']).toBe('number');
  });

  it('renaming a valid property onto a skipped key is refused, so neither is lost', () => {
    // The rename would have moved rating's values to a key no property reads; refused
    // before anything is written or migrated.
    expect(() =>
      renameProperty(before, { key: 'rating', newKey: 'author', label: 'Author' }),
    ).toThrowError(TypeEditError);
  });

  it('naming a new property after a skipped one keeps what the file said of the skipped one', () => {
    // The editor's "+": a placeholder, written, then named.
    const placeholder = { ...WRITTEN, properties: { ...WRITTEN.properties, property: 'text' } };
    const read = parseObjectType(placeholder);
    const after = renameProperty(read, {
      key: 'property',
      newKey: 'property',
      label: 'Author',
    }).type;
    const changes = typeFrontmatterChanges({ before: read, after, written: placeholder });
    const properties = changes['properties'] as Record<string, unknown>;
    // Either the new key steers clear of `author`, or the hand-typed spec survives: never overwritten.
    expect(Object.values(properties)).toContainEqual(WRITTEN.properties.author);
    expect(
      parseObjectType({ ...placeholder, properties }).properties.map((p) => p.label),
    ).toContain('Author');
  });
});
