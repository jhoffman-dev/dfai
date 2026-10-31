/**
 * Second attack on PR #687 (#683), through the real YAML port: an edit saved
 * over a type file that holds properties the type cannot read must keep each
 * of those, in place, and must never write one of its own over them.
 */
import { describe, expect, it } from 'vitest';
import {
  addProperty,
  moveProperty,
  removeProperty,
  renameProperty,
  setTypeLabel,
  type ObjectType,
} from '@dfai/domain';
import { apiFixture, loadTypeListing, saveObjectType } from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const PATH = '.atlas/types/book.md';

async function opened(text: string) {
  const fixture = apiFixture({ files: { [PATH]: text }, markdown: remarkMarkdown });
  const listing = await loadTypeListing({ fs: fixture.fs, markdown: remarkMarkdown });
  const before = listing.types[0]!;
  const save = async (type: ObjectType) => {
    await saveObjectType({
      fs: fixture.fs,
      markdown: remarkMarkdown,
      path: before.path,
      before,
      type,
    });
    return fixture.files.get(PATH)!.text;
  };
  return { fixture, before, save };
}

const lines = (...all: string[]) => all.join('\n');

describe('unread properties survive an edit (attack 2 on #687)', () => {
  it('keeps a comment, a blank line and an unread spec, in place, when a read property moves', async () => {
    const text = lines(
      '---',
      'name: book',
      'label: Book',
      'properties:',
      '  # the rating, out of five',
      '  rating: number',
      '',
      '  author: {kind: relation, targets: person} # typo kept by hand',
      '  pages: number',
      '---',
      '',
    );
    const { before, save } = await opened(text);
    expect(before.unreadKeys).toEqual(['author']);
    const written = await save(moveProperty(before, { key: 'pages', to: 0 }));
    expect(written).toContain('  author: {kind: relation, targets: person} # typo kept by hand\n');
    expect(written).toContain('  # the rating, out of five\n');
    const order = ['pages:', 'author:', 'rating:'].map((key) => written.indexOf(`  ${key}`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // Pre-existing in the YAML port, not new in #687: the `properties` pair is
  // re-stringified, so the spacing inside an unread spec is normalised — the
  // values and comment survive, the bytes the person typed do not. Left failing
  // for issue #697 (rewriting a type's properties map changes the spacing of
  // entries it didn't touch); it flips when that is fixed.
  it.fails(
    'keeps the bytes of an unread spec, spacing and all, when another property moves',
    async () => {
      const unread = "  author:\n    kind: relation\n    targets:   'person'   # who wrote it\n";
      const text = `---\nname: book\nproperties:\n  rating: number\n${unread}  pages: number\n---\n`;
      const { save, before } = await opened(text);
      const written = await save(moveProperty(before, { key: 'pages', to: 0 }));
      expect(written).toContain(unread);
    },
  );

  it('keeps a flow-style map’s unread entry when a property is added under its name', async () => {
    const text = lines(
      '---',
      'name: book',
      'properties: {rating: number, author: {kind: wizard}}',
      '---',
      '',
    );
    const { before, save } = await opened(text);
    const written = await save(addProperty(before, { label: 'Author' }));
    expect(written).toContain('author: {kind: wizard}');
    expect(written).toContain('author_2');
  });

  it('gives a new property author_3 when author and author_2 are both unread, keeping both', async () => {
    const text = lines(
      '---',
      'name: book',
      'properties:',
      '  author: {kind: wizard}',
      '  author_2: {kind: wizard}',
      '---',
      '',
    );
    const { before, save } = await opened(text);
    const added = addProperty(before, { label: 'Author' });
    expect(added.properties.at(-1)?.key).toBe('author_3');
    expect(await save(added)).toContain('  author: {kind: wizard}\n  author_2: {kind: wizard}\n');
  });

  it('gives a new property author_2 when the unread key is Author, in capitals', async () => {
    const text = lines('---', 'name: book', 'properties:', '  Author: {kind: wizard}', '---', '');
    const { before } = await opened(text);
    expect(addProperty(before, { label: 'author' }).properties.at(-1)?.key).toBe('author_2');
  });

  it('keeps an unread Author when the read author beside it is removed', async () => {
    const text = lines(
      '---',
      'name: book',
      'properties:',
      '  author: text',
      '  Author: {kind: wizard}',
      '---',
      '',
    );
    const { before, save } = await opened(text);
    const written = await save(removeProperty(before, 'author').type);
    expect(written).toContain('  Author: {kind: wizard}\n');
    expect(written).not.toMatch(/^ {2}author:/m);
  });

  it('refuses a rename onto an unread key that differs only in case or in spaces', async () => {
    const text = lines(
      '---',
      'name: book',
      'properties:',
      '  title: text',
      '  " Author ": {kind: wizard}',
      '---',
      '',
    );
    const { before } = await opened(text);
    expect(() =>
      renameProperty(before, { key: 'title', newKey: 'author', label: 'Author' }),
    ).toThrow(/already in the type file/);
  });

  it('refuses, writing nothing, a property added under a key another editor wrote meanwhile', async () => {
    const text = lines('---', 'name: book', 'properties:', '  rating: number', '---', '');
    const { fixture, before, save } = await opened(text);
    const meanwhile = lines(
      '---',
      'name: book',
      'properties:',
      '  rating: number',
      '  author: {kind: relation, target: person, hint: by hand}',
      '---',
      '',
    );
    fixture.files.set(PATH, { text: meanwhile, modified: 999 });
    await expect(save(addProperty(before, { label: 'Author' }))).rejects.toThrow(/already holds/);
    expect(fixture.files.get(PATH)?.text).toBe(meanwhile);
  });

  it('keeps the fix to an unread key made in the file while the editor was open', async () => {
    const text = lines('---', 'name: book', 'properties:', '  author: {kind: wizard}', '---', '');
    const { fixture, before, save } = await opened(text);
    const fixed = text.replace('wizard', 'text');
    fixture.files.set(PATH, { text: fixed, modified: 999 });
    const written = await save(addProperty(setTypeLabel(before, 'Books'), { label: 'Author' }));
    expect(written).toContain('  author: {kind: text}\n');
    expect(written).toContain('author_2');
  });

  it('keeps an unread "Author!" and a unicode Ünit beside the plain keys added after them', async () => {
    const text = lines(
      '---',
      'name: book',
      'properties:',
      '  "Author!": {kind: wizard}',
      '  Ünit: {kind: wizard}',
      '---',
      '',
    );
    const { before, save } = await opened(text);
    const written = await save(
      addProperty(addProperty(before, { label: 'Author' }), { label: 'Ünit' }),
    );
    expect(written).toContain('  "Author!": {kind: wizard}\n  Ünit: {kind: wizard}\n');
    expect(written).toMatch(/^ {2}author: text$/m);
    expect(written).toMatch(/^ {2}unit:$/m);
  });
});

describe('keys the file already holds twice, as the parser trims them (attack 2 on #687)', () => {
  // `" author"` and `author` are two keys to YAML, both in the file before any
  // edit. refuseWritingOver compares trimmed keys, so it takes the file's own
  // pair for a write over one of them: every edit of the properties is now
  // refused, though the edit touches neither. Before d0f0da78 it saved.
  it.fails(
    'saves a move of another property when the file holds " author" and author',
    async () => {
      const text = lines(
        '---',
        'name: book',
        'properties:',
        '  " author": {kind: wizard}',
        '  author: text',
        '  rating: number',
        '---',
        '',
      );
      const { before, save } = await opened(text);
      const written = await save(moveProperty(before, { key: 'rating', to: 0 }));
      expect(written).toContain('  " author": {kind: wizard}\n');
      expect(written).toMatch(/^ {2}author: text$/m);
    },
  );

  // The same pair makes the type both read `author` and list it as unread: a
  // key the type holds and says it cannot read, which is a state the editor
  // should never be handed.
  it.fails('never lists a key as unread that the type also reads', async () => {
    const text = lines(
      '---',
      'name: book',
      'properties:',
      '  " author": {kind: wizard}',
      '  author: text',
      '---',
      '',
    );
    const { before } = await opened(text);
    const read = before.properties.map((property) => property.key);
    expect((before.unreadKeys ?? []).filter((key) => read.includes(key))).toEqual([]);
  });

  // Two blank keys are skipped without a word (the file is not listed as
  // broken), and then refuseWritingOver refuses adding any property, saying
  // the file "already holds """.
  it.fails('adds a property to a type file holding two blank keys it skips', async () => {
    const text = lines(
      '---',
      'name: book',
      'properties:',
      '  rating: number',
      '  "": {kind: wizard}',
      '  "  ": text',
      '---',
      '',
    );
    const { before, save } = await opened(text);
    const written = await save(addProperty(before, { label: 'Pages' }));
    expect(written).toMatch(/^ {2}pages: text$/m);
    expect(written).toContain('  "": {kind: wizard}\n');
  });
});
