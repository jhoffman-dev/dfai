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
      [path, 'Its frontmatter has no closing --- line, so none of it is read.'],
    ]);
  });

  // The port reads a block that is a list or one scalar as no properties, and says
  // nothing is wrong, so it cannot say it is a type. Fixed by PR #682, which makes
  // `frontmatterProblem` report a block that is not a mapping: these flip then.
  it.fails(
    'lists a type file whose frontmatter is a list, not a mapping (fixed by PR #682)',
    async () => {
      const path = '.atlas/types/Film.md';
      const text = ['---', '- name: film', '  label: Film', '---', ''].join('\n');
      expect((await brokenBeside({ [path]: text })).map(([listed]) => listed)).toEqual([path]);
    },
  );

  it.fails('lists a type file whose frontmatter is one scalar (fixed by PR #682)', async () => {
    const path = '.atlas/types/Film.md';
    const text = ['---', 'name film', '---', ''].join('\n');
    expect((await brokenBeside({ [path]: text })).map(([listed]) => listed)).toEqual([path]);
  });
});
