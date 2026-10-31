import { describe, expect, it } from 'vitest';
import { parseObjectType } from './property-def.ts';
import {
  addProperty,
  moveProperty,
  removeProperty,
  renameOption,
  renameProperty,
  setOptionColor,
  setPropertyRequired,
  setTypeIcon,
  setTypeLabel,
} from './type-edit.ts';
import {
  newTypeFrontmatter,
  propertySpec,
  typeFrontmatter,
  typeFrontmatterChanges,
} from './type-frontmatter.ts';

const SOURCE = {
  name: 'task',
  label: 'Task',
  properties: {
    status: { kind: 'select', options: ['backlog', 'done'], required: true },
    due: 'date',
    blocked_by: { kind: 'text', many: true },
    project: { kind: 'relation', target: 'project' },
    tags: { kind: 'multiSelect', options: ['a'] },
    estimate: { kind: 'text', label: 'Size' },
  },
};

describe('writing a type back', () => {
  const type = parseObjectType(SOURCE);

  it('parses back to the same type', () => {
    expect(parseObjectType({ name: 'task', ...typeFrontmatter(type) })).toEqual(type);
  });

  it('keeps an icon and option colours through the round trip', () => {
    const edited = renameOption(setTypeIcon(type, 'board'), {
      key: 'status',
      from: 'backlog',
      to: 'queued',
    }).type;
    expect(parseObjectType(newTypeFrontmatter(edited))).toEqual(edited);
  });

  it('writes the shorthand when the kind is all there is to say', () => {
    expect(propertySpec(type.properties[1]!)).toBe('date');
  });

  it('writes only what differs from the defaults', () => {
    expect(propertySpec(type.properties[0]!)).toEqual({
      kind: 'select',
      options: ['backlog', 'done'],
      required: true,
    });
    // multiSelect is many by definition; a label read from the key is not repeated.
    expect(propertySpec(type.properties[4]!)).toEqual({ kind: 'multiSelect', options: ['a'] });
    expect(propertySpec(type.properties[5]!)).toEqual({ kind: 'text', label: 'Size' });
    expect(propertySpec(type.properties[2]!)).toEqual({ kind: 'text', many: true });
  });

  it('removes the icon key when there is no icon, and never rewrites the name', () => {
    const written = typeFrontmatter(type);
    expect(written['icon']).toBeNull();
    expect('name' in written).toBe(false);
    expect(newTypeFrontmatter(type)['name']).toBe('task');
  });

  it('leaves an empty properties map out of a new type file', () => {
    const empty = { name: 'book', label: 'Book', properties: [] };
    expect('properties' in newTypeFrontmatter(empty)).toBe(false);
    expect(parseObjectType(newTypeFrontmatter(empty))).toEqual(empty);
  });
});

describe('what an edit changes in a type file', () => {
  // Written by hand: an icon the app does not offer, a key inside a spec it
  // does not read, a kind it does not know, a relation with nothing to point
  // at, and a colour off its palette. None of it is the editor's to remove.
  const WRITTEN = {
    name: 'book',
    label: 'Book',
    icon: 'rocket',
    properties: {
      rating: { kind: 'number', hint: 'out of five' },
      score: { kind: 'formula' },
      stage: { kind: 'select', options: ['draft', 'out'], colors: { draft: 'teal', out: 'done' } },
      author: { kind: 'relation' },
      pages: 'number',
    },
  };
  const before = parseObjectType(WRITTEN);
  const changes = (after: typeof before) =>
    typeFrontmatterChanges({ before, after, written: WRITTEN });

  it('reads only what it understands, so the rest must be left to the file', () => {
    expect(before.icon).toBeUndefined();
    expect(before.properties.map((property) => property.key)).toEqual(['rating', 'stage', 'pages']);
  });

  it('changes only the label when only the label changed', () => {
    expect(changes(setTypeLabel(before, 'Books'))).toEqual({ label: 'Books' });
  });

  it('changes the icon only when it was edited', () => {
    expect(changes(setTypeIcon(before, 'grid'))).toEqual({ icon: 'grid' });
    expect(changes(before)).toEqual({});
  });

  it('merges an edited property into what was written, keeping keys it does not read', () => {
    const after = renameProperty(before, { key: 'rating', newKey: 'rating', label: 'Stars' }).type;
    expect(changes(after)).toEqual({
      properties: {
        ...WRITTEN.properties,
        rating: { kind: 'number', hint: 'out of five', label: 'Stars' },
      },
    });
  });

  it('adds a property beside one whose key is written with spaces, adding no second key of its own', () => {
    const spaced = { name: 'meeting', properties: { ' title': 'text', when: 'date' } };
    const read = parseObjectType(spaced);
    const after = addProperty(read, { label: 'Tasks', kind: 'text' });
    const written = typeFrontmatterChanges({ before: read, after, written: spaced })[
      'properties'
    ] as Record<string, unknown>;
    expect(written).toStrictEqual({ ' title': 'text', when: 'date', tasks: 'text' });
  });

  it('edits a property whose key is written with spaces in place, keeping its spelling', () => {
    const spaced = { name: 'meeting', properties: { ' title ': { kind: 'text', hint: 'h' } } };
    const read = parseObjectType(spaced);
    const after = renameProperty(read, { key: 'title', newKey: 'title', label: 'Called' }).type;
    const written = typeFrontmatterChanges({ before: read, after, written: spaced })[
      'properties'
    ] as Record<string, unknown>;
    expect(written).toStrictEqual({ ' title ': { kind: 'text', hint: 'h', label: 'Called' } });
  });

  it('keeps the unread keys of a renamed property, where it stood', () => {
    const after = renameProperty(before, { key: 'rating', newKey: 'stars', label: 'Stars' }).type;
    const written = changes(after)['properties'] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['stars', 'score', 'stage', 'author', 'pages']);
    // "Stars" is what the key reads as, so no label is written.
    expect(written['stars']).toEqual({ kind: 'number', hint: 'out of five' });
    expect('rating' in written).toBe(false);
  });

  it('keeps a colour off the palette when another colour of the property changes', () => {
    const after = setOptionColor(before, { key: 'stage', option: 'out', tone: 'review' });
    const written = changes(after)['properties'] as Record<string, Record<string, unknown>>;
    expect(written['stage']?.['colors']).toEqual({ draft: 'teal', out: 'review' });
  });

  it('moves properties among the ones it does not read, leaving those where they are', () => {
    const after = moveProperty(before, { key: 'pages', to: 0 });
    const written = changes(after)['properties'] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['pages', 'score', 'rating', 'author', 'stage']);
    expect(written).toMatchObject(WRITTEN.properties);
  });

  it('removes and adds only the property edited', () => {
    const removed = changes(removeProperty(before, 'stage').type)['properties'];
    expect(Object.keys(removed as object)).toEqual(['rating', 'score', 'author', 'pages']);
    const added = changes(addProperty(before, { label: 'Year', kind: 'number' }))['properties'];
    expect(added).toEqual({ ...WRITTEN.properties, year: 'number' });
  });

  it('writes the shorthand for an edited property that had nothing else to say', () => {
    const after = renameProperty(before, { key: 'pages', newKey: 'length', label: 'Length' }).type;
    const written = changes(after)['properties'] as Record<string, unknown>;
    expect(written['length']).toBe('number');
    expect('pages' in written).toBe(false);
  });
});

describe('a shorthand property edited and put back', () => {
  it('is written as the shorthand again once its long form would say only the kind', () => {
    const plain = parseObjectType({ name: 'x', properties: { date: 'date' } });
    const required = parseObjectType({
      name: 'x',
      properties: { date: { kind: 'date', required: true } },
    });
    const changes = typeFrontmatterChanges({
      before: required,
      after: plain,
      written: { properties: { date: { kind: 'date', required: true } } },
    });
    expect(changes).toEqual({ properties: { date: 'date' } });
  });

  it('keeps the long form where the file holds a key of its own beside the kind', () => {
    const plain = parseObjectType({ name: 'x', properties: { date: 'date' } });
    const required = parseObjectType({
      name: 'x',
      properties: { date: { kind: 'date', required: true } },
    });
    const changes = typeFrontmatterChanges({
      before: required,
      after: plain,
      written: { properties: { date: { kind: 'date', required: true, note: 'mine' } } },
    });
    expect(changes).toEqual({ properties: { date: { kind: 'date', note: 'mine' } } });
  });
});

describe('typeFrontmatterChanges, beside a property the file holds unread (#683)', () => {
  const written = {
    name: 'book',
    properties: {
      rating: 'number',
      author: { kind: 'relation', targets: 'person' },
      pages: 'number',
    },
  };
  const before = parseObjectType(written);
  const author = {
    ...before.properties[0]!,
    key: 'author',
    label: 'Author',
    kind: 'text' as const,
  };

  it('refuses a property given the unread key, rather than write over what the file says of it', () => {
    // Made by hand: the editor keeps clear of the key, so only a caller around it could.
    const after = { ...before, properties: [...before.properties, author] };
    expect(() => typeFrontmatterChanges({ before, after, written })).toThrowError(
      'The type file already holds "author", so it is not written over',
    );
  });

  it('refuses one put first, too, rather than moving the valid properties into its place', () => {
    const after = { ...before, properties: [author, ...before.properties] };
    expect(() => typeFrontmatterChanges({ before, after, written })).toThrowError(
      'The type file already holds "author", so it is not written over',
    );
  });
});

describe('typeFrontmatterChanges, on keys the file holds twice as the parser trims them (#683)', () => {
  it('moves a property beside " author" and author, keeping each spec under its own key', () => {
    const written = {
      name: 'book',
      properties: { ' author': { kind: 'wizard' }, author: 'text', rating: 'number' },
    };
    const before = parseObjectType(written);
    const after = moveProperty(before, { key: 'rating', to: 0 });
    const properties = typeFrontmatterChanges({ before, after, written })['properties'];
    expect(properties).toEqual({ ' author': { kind: 'wizard' }, rating: 'number', author: 'text' });
  });

  it('writes an edit of the read author into its own entry, never the skipped " author"', () => {
    const written = { name: 'book', properties: { ' author': { kind: 'wizard' }, author: 'text' } };
    const before = parseObjectType(written);
    const after = setPropertyRequired(before, { key: 'author', required: true });
    const properties = typeFrontmatterChanges({ before, after, written })['properties'];
    expect(properties).toEqual({
      ' author': { kind: 'wizard' },
      author: { kind: 'text', required: true },
    });
  });

  it('adds a property beside two blank keys, carrying both through as they were', () => {
    const written = {
      name: 'book',
      properties: { rating: 'number', '': { kind: 'wizard' }, '  ': 'text' },
    };
    const before = parseObjectType(written);
    const after = addProperty(before, { label: 'Pages' });
    const properties = typeFrontmatterChanges({ before, after, written })['properties'];
    expect(properties).toEqual({
      rating: 'number',
      '': { kind: 'wizard' },
      '  ': 'text',
      pages: 'text',
    });
  });
});
