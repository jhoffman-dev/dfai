/**
 * Attack on PR #687 (#683): a type now loads without a property it cannot read,
 * and the sidebar says so — which invites the person to make that property
 * again in the type editor, under the same name. The editor's write works the
 * file's `properties` out against the keys it read, and a key it skipped is
 * not among them, so a property given that key is mis-placed in the rebuild.
 */
import { describe, expect, it } from 'vitest';
import { parseObjectType } from './property-def.ts';
import { addProperty, moveProperty, renameProperty } from './type-edit.ts';
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
  it('reads author as skipped, so the editor offers its key again', () => {
    expect(before.properties.map((property) => property.key)).toEqual(['rating', 'pages']);
    expect(addProperty(before, { label: 'Author', kind: 'text' }).properties.at(-1)?.key).toBe(
      'author',
    );
  });

  it.fails('a property added under the key of a skipped one is written to the file', () => {
    const after = addProperty(before, { label: 'Author', kind: 'text' });
    // Observed: the changes hold the file's properties exactly as they were; the new one is dropped.
    expect(written(after).reread.properties.map((property) => property.label)).toContain('Author');
  });

  it.fails('moving such a property to the top keeps every valid property in the file', () => {
    const added = addProperty(before, { label: 'Author', kind: 'text' });
    const after = moveProperty(added, { key: 'author', to: 0 });
    // Observed: `pages: number`, a valid property nobody touched, is deleted from the file.
    expect(Object.keys(written(after).properties)).toEqual(
      expect.arrayContaining(['rating', 'pages']),
    );
  });

  it.fails('renaming a valid property onto a skipped key keeps the valid property', () => {
    const after = renameProperty(before, { key: 'rating', newKey: 'author', label: 'Author' }).type;
    // Observed: the rename's spec is overwritten by the skipped author's raw one, so
    // rating's definition is gone and its notes' values (migrated to `author`) are untyped.
    expect(written(after).reread.properties.map((property) => property.label)).toContain('Author');
  });

  it.fails(
    'naming a new property after a skipped one keeps what the file said of the skipped one',
    () => {
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
    },
  );
});
