import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { loadObjectTypes, loadTypeListing, noteTypeName } from './load-types.ts';

const file = (name: string): VaultEntry => ({
  kind: 'file',
  name,
  path: createVaultPath(`.atlas/types/${name}`),
});

describe('loadObjectTypes', () => {
  it('reads each type with the file it is written in, sorted by name', async () => {
    const texts: Record<string, string> = {
      '.atlas/types/Tasks.md': '---\nname: task\nlabel: Task\n---\n',
      '.atlas/types/book.md': '---\nname: book\n---\n',
    };
    const fs = fakeVaultFs({
      listDirectory: async () => [file('Tasks.md'), file('book.md'), file('notes.txt')],
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: texts[path] ?? '', modified: 1, size: 1 })),
    });
    const types = await loadObjectTypes({ fs, markdown: fakeMarkdown() });
    expect(types.map((type) => [type.name, type.path])).toEqual([
      ['book', '.atlas/types/book.md'],
      // The file need not be named after the type; an edit writes where it was found.
      ['task', '.atlas/types/Tasks.md'],
    ]);
  });

  it('skips a file that is not a type, and has none without a types folder', async () => {
    const fs = fakeVaultFs({
      listDirectory: async () => [file('broken.md')],
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: 'no name', modified: 1, size: 1 })),
    });
    expect(await loadObjectTypes({ fs, markdown: fakeMarkdown() })).toEqual([]);
    const missing = fakeVaultFs({
      listDirectory: async () => {
        throw new Error('no such folder');
      },
    });
    expect(await loadObjectTypes({ fs: missing, markdown: fakeMarkdown() })).toEqual([]);
  });
});

const PARSER_REASON = 'Unexpected end of flow sequence at line 2, column 8';

/** The real port's contract for a block that is not YAML: no properties, and `frontmatterProblem` says why. */
function yamlFailingOn(unreadable: string): MarkdownPort {
  const markdown = fakeMarkdown();
  return {
    ...markdown,
    frontmatterProperties: (frontmatter, read) =>
      frontmatter?.includes(unreadable) === true
        ? {}
        : markdown.frontmatterProperties(frontmatter, read),
    frontmatterProblem: (frontmatter) =>
      frontmatter?.includes(unreadable) === true ? PARSER_REASON : null,
  };
}

/** `key: value` lines, each value read as JSON when it is JSON: enough for a type's properties. */
function jsonProperties(): MarkdownPort {
  const markdown = fakeMarkdown();
  const valueOf = (raw: unknown) => {
    try {
      return JSON.parse(String(raw)) as unknown;
    } catch {
      // Not JSON: the plain text it was written as.
      return raw;
    }
  };
  return {
    ...markdown,
    frontmatterProperties: (frontmatter) =>
      Object.fromEntries(
        Object.entries(markdown.frontmatterProperties(frontmatter)).map(([key, raw]) => [
          key,
          valueOf(raw),
        ]),
      ),
  };
}

describe('loadTypeListing', () => {
  it('lists a type file whose frontmatter cannot be read as broken, with the parser reason, and loads the types beside it (#683)', async () => {
    const texts: Record<string, string> = {
      // The broken file is read first: the files after it still load.
      '.atlas/types/Recipe.md': '---\nname: recipe\nproperties: [\n---\n',
      '.atlas/types/book.md': '---\nname: book\n---\n',
      '.atlas/types/README.md': '# What these types are\n',
      '.atlas/types/Notes.md': '---\ntitle: Notes on the types\n---\n',
    };
    const fs = fakeVaultFs({
      listDirectory: async () =>
        Object.keys(texts).map((path) => file(path.split('/').at(-1) ?? '')),
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: texts[path] ?? '', modified: 1, size: 1 })),
    });
    const listing = await loadTypeListing({ fs, markdown: yamlFailingOn('properties: [') });
    expect(listing.types.map((type) => type.name)).toEqual(['book']);
    // Only the file that is not YAML: no frontmatter, or readable frontmatter that is no type, is not a problem.
    expect(listing.broken).toEqual([
      {
        path: '.atlas/types/Recipe.md',
        name: 'Recipe',
        problem: `Its frontmatter is not valid YAML: ${PARSER_REASON}`,
      },
    ]);
  });

  it('lists a type file that reads but is no whole type, with why, and loads what it can', async () => {
    const texts: Record<string, string> = {
      // No name: not a type at all, so it is listed and not loaded.
      '.atlas/types/Recipe.md': '---\nlabel: Recipe\nproperties: {"serves": "number"}\n---\n',
      // A property of a kind there is not: the type loads without it, and says so.
      '.atlas/types/book.md': '---\nname: book\nproperties: {"pages": "nmber"}\n---\n',
      // A closing fence deleted: the block is not frontmatter, so it cannot say it is a type.
      '.atlas/types/Film.md': '---\nname: film\nlabel: Film\n\n# Film\n',
      // A block that reads as no properties at all, though it holds something.
      '.atlas/types/Song.md': '---\n- name: song\n---\n',
      // A blank block says nothing, so there is nothing wrong with it.
      '.atlas/types/Draft.md': '---\n---\n\n# Draft\n',
    };
    const fs = fakeVaultFs({
      listDirectory: async () =>
        Object.keys(texts).map((path) => file(path.split('/').at(-1) ?? '')),
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: texts[path] ?? '', modified: 1, size: 1 })),
    });
    const listing = await loadTypeListing({ fs, markdown: jsonProperties() });
    expect(listing.types.map((type) => [type.name, type.properties.length])).toEqual([['book', 0]]);
    expect(listing.broken).toEqual([
      {
        path: '.atlas/types/book.md',
        name: 'book',
        problem: 'Its property “pages” has a kind DFAI does not know: “nmber”.',
      },
      {
        path: '.atlas/types/Film.md',
        name: 'Film',
        problem: 'Its frontmatter has no closing ---.',
      },
      {
        path: '.atlas/types/Recipe.md',
        name: 'Recipe',
        problem: 'It has no name, and a type needs one.',
      },
      {
        path: '.atlas/types/Song.md',
        name: 'Song',
        problem: 'Its frontmatter is not a set of properties.',
      },
    ]);
  });

  it('has nothing broken without a types folder', async () => {
    const missing = fakeVaultFs({
      listDirectory: async () => {
        throw new Error('no such folder');
      },
    });
    expect(await loadTypeListing({ fs: missing, markdown: fakeMarkdown() })).toEqual({
      types: [],
      broken: [],
    });
  });
});

describe('noteTypeName', () => {
  it('is the declared type, or null when there is none', () => {
    expect(noteTypeName({ type: ' task ' })).toBe('task');
    expect(noteTypeName({ type: '' })).toBeNull();
    expect(noteTypeName({})).toBeNull();
  });
});
