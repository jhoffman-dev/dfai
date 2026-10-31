import { describe, expect, it } from 'vitest';
import { createVaultPath, skillUsers, type AutomationRule } from '@dfai/domain';
import type { AutomationListing } from '@dfai/application';
import { skillUsersKey, skillUsersOf } from './skill-users-key.ts';

/**
 * Attack on PR #629 (#169): "Used by" comes from one text compared by its
 * content. Two different sets of rules must never share a key, the same set
 * must always, and every name comes back exactly as it was — whatever it holds.
 */

const rule = (name: string, skill?: string): AutomationRule => ({
  id: name,
  path: createVaultPath('.atlas/automations/rule.md'),
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

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ODD_NAMES = [
  'Weekly notes',
  'Line\none',
  'NUL\u0000inside',
  'backslash \\0 written',
  '😀 emoji',
  'lone \ud83d surrogate',
  '"],["x","y',
  '[',
  '',
  ' ',
  'Café',
  'Café',
  'ＷＥＥＫＬＹ',
  'x,a;y',
  'x',
  'y',
];

describe('the key of which rules use a skill, attacked (#629 attack)', () => {
  it('gives back every name exactly, whatever characters it holds', () => {
    const rules = ODD_NAMES.map((name) => rule(name, 'weekly-notes'));
    const back = skillUsersOf(skillUsersKey(listingOf(rules))).map(({ name }) => name);
    expect([...back].sort()).toEqual([...ODD_NAMES].sort());
  });

  it('never gives two different sets of rules the same key', () => {
    const random = seeded(629169);
    const seen = new Map<string, string>();
    for (let round = 0; round < 500; round += 1) {
      const count = Math.floor(random() * 4);
      const pairs: [string, string][] = [];
      for (let index = 0; index < count; index += 1) {
        pairs.push([
          ODD_NAMES[Math.floor(random() * ODD_NAMES.length)] as string,
          ['a', 'b', 'a-b'][Math.floor(random() * 3)] as string,
        ]);
      }
      const canonical = JSON.stringify(pairs.map((pair) => JSON.stringify(pair)).sort());
      const key = skillUsersKey(listingOf(pairs.map(([name, skill]) => rule(name, skill))));
      const before = seen.get(key);
      if (before !== undefined) expect(before).toBe(canonical);
      seen.set(key, canonical);
    }
  });

  it('tells a name holding separators apart from two rules', () => {
    expect(skillUsersKey(listingOf([rule('x,a;y', 'b')]))).not.toBe(
      skillUsersKey(listingOf([rule('x', 'a'), rule('y', 'b')])),
    );
  });

  it('is the same for 1,000 rules read again in a shuffled order, and finds each user', () => {
    const random = seeded(20261028);
    const rules = Array.from({ length: 1000 }, (_, index) =>
      rule(
        `Rule ${index}`,
        index % 3 === 0 ? 'weekly-notes' : index % 3 === 1 ? 'other' : undefined,
      ),
    );
    const shuffled = [...rules].sort(() => random() - 0.5).map((each) => structuredClone(each));
    const key = skillUsersKey(listingOf(rules));
    expect(skillUsersKey(listingOf(shuffled))).toBe(key);
    expect(skillUsers(skillUsersOf(key), 'weekly-notes')).toHaveLength(334);
  });

  it('counts a broken rule and a readable one of the same name once, by name', () => {
    const listing = listingOf(
      [rule('Weekly notes', 'weekly-notes')],
      [
        {
          path: createVaultPath('.atlas/automations/Weekly notes 2.md'),
          name: 'Weekly notes',
          problem: 'Write enabled: true or false.',
          skill: 'weekly-notes',
        },
      ],
    );
    expect(skillUsers(skillUsersOf(skillUsersKey(listing)), 'weekly-notes')).toEqual([
      'Weekly notes',
    ]);
  });
});
