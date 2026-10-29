import { describe, expect, it } from 'vitest';
import { createVaultPath, type AutomationRule } from '@dfai/domain';
import type { AutomationListing } from '@dfai/application';
import { skillUsersKey, skillUsersOf } from './skill-users-key.ts';

/**
 * #629 review: which rules use which skill, as one text compared by its
 * content, so the Skills page draws again only when that changes — never for
 * the runner's minute or a run, which read the same rules into new objects.
 */

const rule = (name: string, skill?: string): AutomationRule => ({
  id: name,
  path: createVaultPath(`.atlas/automations/${name}.md`),
  name,
  enabled: true,
  when: { kind: 'manual' },
  which: 'FROM meeting',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: skill === undefined ? '.atlas/prompts/x.md' : `.atlas/skills/${skill}/SKILL.md`,
    ...(skill !== undefined && { skill }),
    tools: [],
    output: { kind: 'proposals', schema: 'proposals' },
  },
});

const listingOf = (
  rules: AutomationRule[],
  broken: AutomationListing['broken'] = [],
): AutomationListing =>
  ({
    automations: rules.map((each) => ({ rule: each, log: [], ledger: [], idWritten: false })),
    broken,
  }) as unknown as AutomationListing;

describe('the key of which rules use a skill', () => {
  it('is the same for the same rules read again into new objects', () => {
    const first = listingOf([rule('Weekly notes', 'weekly-notes'), rule('By prompt')]);
    const again = listingOf([rule('Weekly notes', 'weekly-notes'), rule('By prompt')]);
    expect(first).not.toBe(again);
    expect(skillUsersKey(again)).toBe(skillUsersKey(first));
  });

  it('is the same whatever order the rules are listed in', () => {
    const a = rule('A', 'one');
    const b = rule('B', 'two');
    expect(skillUsersKey(listingOf([a, b]))).toBe(skillUsersKey(listingOf([b, a])));
  });

  it('changes when a rule names another skill, or stops naming one', () => {
    const before = skillUsersKey(listingOf([rule('A', 'one')]));
    expect(skillUsersKey(listingOf([rule('A', 'two')]))).not.toBe(before);
    expect(skillUsersKey(listingOf([rule('A')]))).not.toBe(before);
  });

  it('is empty with no listing, or no rule naming a skill', () => {
    expect(skillUsersKey(null)).toBe('');
    expect(skillUsersKey(listingOf([rule('By prompt')]))).toBe('');
  });

  it('reads back as the rules naming a skill, broken ones included', () => {
    const listing = listingOf(
      [rule('Weekly notes', 'weekly-notes'), rule('By prompt')],
      [
        {
          path: createVaultPath('.atlas/automations/Typo.md'),
          name: 'Typo',
          problem: 'A Claude step may use only the read tools.',
          skill: 'weekly-notes',
        },
        { path: createVaultPath('.atlas/automations/Other.md'), name: 'Other', problem: 'x' },
      ],
    );
    expect(skillUsersOf(skillUsersKey(listing))).toEqual([
      { name: 'Typo', action: { kind: 'claude', skill: 'weekly-notes' } },
      { name: 'Weekly notes', action: { kind: 'claude', skill: 'weekly-notes' } },
    ]);
  });

  it('keeps a name holding any character, a line break among them', () => {
    const odd = 'Line\none\u0000two';
    expect(skillUsersOf(skillUsersKey(listingOf([rule(odd, 'x-y')])))).toEqual([
      { name: odd, action: { kind: 'claude', skill: 'x-y' } },
    ]);
  });
});
