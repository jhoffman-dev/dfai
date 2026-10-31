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
/** Files beside the types that are not types: no block, or a readable one with no name. */
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
});
