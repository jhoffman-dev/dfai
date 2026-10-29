/**
 * A skill as a run or a chat turn hands it over (#169): the instructions
 * trimmed, or why not — gone, refused by the host, breaking the rules, or
 * over the run cap measured as a prompt note's `.length`.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PROMPT_CHARACTERS } from '@dfai/domain';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { readSkillToUse } from './skill-to-use.ts';

const SKILL = '.atlas/skills/weekly-review/SKILL.md';
const skillNote = (instructions: string, name = 'weekly-review') =>
  jsonNote({ name, description: 'Reviews the week. Use on Fridays.' }, `\n${instructions}\n`);

function read(notes: Record<string, string>, name = 'weekly-review') {
  const { ports } = automationVault({ notes, today: '2026-10-29' });
  return readSkillToUse({ fs: ports.fs, markdown: ports.markdown, name });
}

describe('readSkillToUse', () => {
  it('gives the instructions, trimmed, of a skill that follows the rules', async () => {
    const found = await read({ [SKILL]: skillNote('  List what Mara Quill finished.  \n\n') });
    expect(found).toEqual({
      kind: 'usable',
      name: 'weekly-review',
      instructions: 'List what Mara Quill finished.',
    });
  });

  it('says a skill not in .atlas/skills is missing', async () => {
    expect(await read({ [SKILL]: skillNote('Review.') }, 'standup')).toEqual({ kind: 'missing' });
  });

  it('says a skill with a problem is unusable, with the problem the Skills page shows', async () => {
    const found = await read({ [SKILL]: skillNote('Review.', 'other-name') });
    expect(found.kind).toBe('unusable');
  });

  it('refuses instructions one past the cap, measured in UTF-16 units, and takes the cap itself', async () => {
    const at = await read({ [SKILL]: skillNote('x'.repeat(MAX_PROMPT_CHARACTERS)) });
    expect(at.kind).toBe('usable');
    const over = await read({ [SKILL]: skillNote('x'.repeat(MAX_PROMPT_CHARACTERS + 1)) });
    expect(over).toMatchObject({ kind: 'unusable', message: expect.stringContaining('20000') });
  });

  it('says what DFAI knows, not the host, when .atlas/skills cannot be listed', async () => {
    const { ports } = automationVault({ notes: { [SKILL]: skillNote('Review.') }, today: 'x' });
    const found = await readSkillToUse({
      fs: {
        ...ports.fs,
        listDirectory: async (parent) => {
          if (parent === '.atlas/skills') throw new VaultAccessError('/Users/mara: denied');
          return ports.fs.listDirectory(parent);
        },
      },
      markdown: ports.markdown,
      name: 'weekly-review',
    });
    expect(found).toEqual({ kind: 'unreadable' });
  });
});
