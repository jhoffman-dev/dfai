/**
 * The vault's types through the real YAML markdown port (#683): a type file
 * whose frontmatter is not YAML is listed as broken with the parser's reason,
 * never silently left out, and the types beside it still load. A file with no
 * frontmatter, or readable frontmatter that is no type, is neither.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, loadTypeListing } from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  due: date',
  '---',
  '',
].join('\n');
/** A type with a flow sequence left open: the parser gives up on the whole block. */
const MALFORMED = ['---', 'name: recipe', 'label: Recipe', 'properties: [serves', '---', ''].join(
  '\n',
);
const MALFORMED_PATH = '.atlas/types/Recipe.md';
/** Files beside the types that are not types: no block, or a readable one with none of a type's keys. */
const NOT_TYPES = {
  '.atlas/types/README.md': '# What these types are\n',
  '.atlas/types/Notes.md': '---\ntitle: Notes on the types\n---\n\nKept beside them.\n',
};

describe('the types through the real markdown port', () => {
  it('lists a type file that is not YAML as broken, with the parser reason, and loads the rest', async () => {
    const { fs } = apiFixture({
      files: { '.atlas/types/task.md': TASK_TYPE, [MALFORMED_PATH]: MALFORMED, ...NOT_TYPES },
      markdown: remarkMarkdown,
    });
    const listing = await loadTypeListing({ fs, markdown: remarkMarkdown });
    expect(listing.types.map((type) => type.name)).toEqual(['task']);
    expect(listing.broken.map(({ path, name }) => [path, name])).toEqual([
      [MALFORMED_PATH, 'Recipe'],
    ]);
    expect(listing.broken[0]?.problem).toMatch(/^Its frontmatter is not valid YAML: \S/);
  });

  /** The broken files listed beside a type that reads, which must load whatever is beside it. */
  async function brokenBeside(files: Record<string, string>) {
    const { fs } = apiFixture({
      files: { '.atlas/types/task.md': TASK_TYPE, ...NOT_TYPES, ...files },
      markdown: remarkMarkdown,
    });
    const listing = await loadTypeListing({ fs, markdown: remarkMarkdown });
    expect(listing.types.map((type) => type.name)).toContain('task');
    return listing.broken.map(({ path, problem }) => [path, problem]);
  }

  it('lists a type file with no name, or a property of no kind there is, with why', async () => {
    const noName = ['---', 'label: Recipe', 'properties:', '  serves: number', '---', ''];
    const badKind = ['---', 'name: book', 'properties:', '  pages: nmber', '---', ''];
    expect(
      await brokenBeside({
        '.atlas/types/Recipe.md': noName.join('\n'),
        '.atlas/types/book.md': badKind.join('\n'),
      }),
    ).toEqual([
      ['.atlas/types/book.md', 'Its property “pages” has a kind DFAI does not know: “nmber”.'],
      ['.atlas/types/Recipe.md', 'It has no name, and a type needs one.'],
    ]);
  });

  it('lists a type file whose closing fence was deleted', async () => {
    const path = '.atlas/types/Film.md';
    const text = ['---', 'name: film', 'label: Film', '', '# Film', ''].join('\n');
    expect(await brokenBeside({ [path]: text })).toEqual([
      // In the words a rule file in the same state gets (PR #682).
      [path, 'Its frontmatter has no closing ---.'],
    ]);
  });

  // The port reads a list or one scalar as no properties, and is right to for any
  // other note; in the types folder it is most likely a type with a typo.
  it.each([
    ['a list', ['---', '- name: film', '  label: Film', '---', '']],
    ['one scalar', ['---', 'name film', '---', '']],
  ])('lists a type file whose frontmatter is %s, not a set of properties', async (_, lines) => {
    const path = '.atlas/types/Film.md';
    expect(await brokenBeside({ [path]: lines.join('\n') })).toEqual([
      [path, 'Its frontmatter is not a set of properties.'],
    ]);
  });

  it('does not list a type file whose frontmatter is blank', async () => {
    expect(await brokenBeside({ '.atlas/types/Film.md': '---\n---\n\n# Film\n' })).toEqual([]);
  });
});
