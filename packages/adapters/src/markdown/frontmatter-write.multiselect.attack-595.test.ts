import { describe, expect, it } from 'vitest';
import { listAsInput, listFromInput } from '@dfai/domain';
import { updateFrontmatter } from './frontmatter-write.ts';
import { parseFrontmatterProperties } from './frontmatter.ts';

/*
 * Attack on PR #595 (#50), ADR-0003: a list the properties panel saves —
 * shown in its box, read back from it, written — holds the same strings when
 * the file is read again, and the lines it did not change keep their bytes.
 */

const YAML_SPECIAL = [
  'yes',
  'no',
  'null',
  '~',
  'true',
  'a: b',
  ':',
  '#',
  'x #y',
  '- x',
  '-',
  '[',
  '{',
  '007',
  '1e3',
  '0x1F',
  '.inf',
  '@x',
  '`b',
  '*a',
  '&a',
  '!t',
  '%p',
  '|',
  '>',
  '?',
  "'q'",
  'Payroll, Larkspur',
  'say "hi"',
];

/** What the panel writes for these items after a keystroke in their box. */
const throughThePanel = (items: readonly string[]): string[] => listFromInput(listAsInput(items));

const FILE = [
  '---',
  '# owner: fictional',
  'clients:',
  '  # the first one',
  '  - Quill # main',
  '  - "Payroll, Larkspur"',
  'tags: [a, "b, c", 007]',
  'title: Today # for now',
  '---',
  '',
].join('\n');

describe('a multi-select saved through the panel (attack #595)', () => {
  it('reads back every YAML-special item as the string it was', () => {
    for (const before of [FILE, '---\nclients: [Quill]\n---\n']) {
      const after = updateFrontmatter(before, { clients: throughThePanel(YAML_SPECIAL) });
      expect(parseFrontmatterProperties(after)['clients']).toEqual(YAML_SPECIAL);
    }
  });

  it('keeps the bytes of the other lists, block and inline, and every comment', () => {
    const after = updateFrontmatter(FILE, { title: 'Tomorrow' });
    expect(after).toBe(FILE.replace('title: Today', 'title: Tomorrow'));
  });

  it('keeps the other lines and the comments outside the list it rewrites', () => {
    const after = updateFrontmatter(FILE, {
      clients: throughThePanel(['Quill', 'Payroll, Larkspur', 'Mara']),
    });
    expect(after).toContain('# owner: fictional\n');
    expect(after).toContain('  # the first one\n');
    expect(after).toContain('tags: [a, "b, c", 007]\ntitle: Today # for now\n');
    expect(parseFrontmatterProperties(after)['clients']).toEqual([
      'Quill',
      'Payroll, Larkspur',
      'Mara',
    ]);
  });
});
