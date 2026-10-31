import { describe, expect, it } from 'vitest';
import { updateFrontmatter } from './frontmatter-write.ts';
import { parseFrontmatterProperties } from './frontmatter.ts';

/*
 * #50: a list item holding a comma of its own — `Payroll, Larkspur` — is one
 * item in the file, read back as one, and kept as written while it is not
 * the one changed.
 */
describe('a list item that holds a comma (#50)', () => {
  const COMMA_ITEM = 'Payroll, Larkspur';

  it('is read as one item from a block list and from an inline list', () => {
    expect(
      parseFrontmatterProperties(`---\nclients:\n  - ${COMMA_ITEM}\n  - Quill\n---\n`),
    ).toEqual({
      clients: [COMMA_ITEM, 'Quill'],
    });
    expect(parseFrontmatterProperties(`---\nclients: ["${COMMA_ITEM}", Quill]\n---\n`)).toEqual({
      clients: [COMMA_ITEM, 'Quill'],
    });
  });

  it('is written so it reads back as one item, after an add, a remove and a reorder', () => {
    const before = `---\nclients:\n  - ${COMMA_ITEM}\n  - Quill\n---\n`;
    for (const next of [[COMMA_ITEM, 'Quill', 'Mara, Inc.'], [COMMA_ITEM], ['Quill', COMMA_ITEM]]) {
      expect(parseFrontmatterProperties(updateFrontmatter(before, { clients: next }))).toEqual({
        clients: next,
      });
    }
  });

  it('keeps its bytes, inline or block, when another key changes', () => {
    const inline = `---\nclients: ["${COMMA_ITEM}", Quill]\ntitle: Today\n---\n`;
    expect(updateFrontmatter(inline, { title: 'Tomorrow' })).toBe(
      `---\nclients: ["${COMMA_ITEM}", Quill]\ntitle: Tomorrow\n---\n`,
    );
    const block = `---\nclients:\n  - ${COMMA_ITEM}\n  - Quill\ntitle: Today\n---\n`;
    expect(updateFrontmatter(block, { title: 'Tomorrow' })).toBe(
      `---\nclients:\n  - ${COMMA_ITEM}\n  - Quill\ntitle: Tomorrow\n---\n`,
    );
  });

  it('keeps an inline list readable when an item holding a comma is added to it', () => {
    const after = updateFrontmatter('---\nclients: [Quill]\n---\n', {
      clients: ['Quill', COMMA_ITEM],
    });
    expect(parseFrontmatterProperties(after)).toEqual({ clients: ['Quill', COMMA_ITEM] });
  });
});
