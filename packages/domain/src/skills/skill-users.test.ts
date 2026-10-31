import { describe, expect, it } from 'vitest';
import { skillInUseWarning, skillUsers, usesSkill, type SkillUser } from './skill-users.ts';

/** #169: the rules that ask with a skill, as the Skills page names them. */

const asks = (name: string, skill?: string): SkillUser => ({
  name,
  action: { kind: 'claude', ...(skill !== undefined && { skill }) },
});

describe('the automations that use a skill', () => {
  const rules: SkillUser[] = [
    asks('Weekly notes', 'meeting-actions'),
    asks('After standup', 'Meeting-Actions'),
    asks('By prompt'),
    asks('Other skill', 'weekly-notes'),
    { name: 'Tidy', action: { kind: 'archive' } },
  ];

  it('are the Claude steps naming it in any case, by name', () => {
    expect(skillUsers(rules, 'meeting-actions')).toEqual(['After standup', 'Weekly notes']);
  });

  it('are none for a skill no rule names', () => {
    expect(skillUsers(rules, 'unused')).toEqual([]);
  });

  it('name a rule once, however often it is listed', () => {
    expect(skillUsers([asks('Twice', 'x-y'), asks('Twice', 'x-y')], 'x-y')).toEqual(['Twice']);
  });
});

describe('the delete question’s warning', () => {
  it('says nothing when no automation uses the skill', () => {
    expect(skillInUseWarning([])).toBeNull();
  });

  it('names the one automation that uses it', () => {
    expect(skillInUseWarning(['Weekly notes'])).toBe(
      'The automation “Weekly notes” uses it, and will fail until it names another skill or a prompt.',
    );
  });

  it('counts and names several', () => {
    expect(skillInUseWarning(['A', 'B'])).toBe(
      '2 automations use it — “A”, “B” — and will fail until each names another skill or a prompt.',
    );
  });
});

describe('whether a rule uses a skill', () => {
  it('compares names as skills are told apart, in any case and form', () => {
    expect(usesSkill({ kind: 'claude', skill: 'ｗeekly-notes' }, 'weekly-notes')).toBe(true);
    expect(usesSkill({ kind: 'claude', skill: 'Weekly-Notes' }, 'weekly-notes')).toBe(true);
    expect(usesSkill({ kind: 'claude', skill: 'weekly-note' }, 'weekly-notes')).toBe(false);
    expect(usesSkill({ kind: 'set', skill: 'weekly-notes' }, 'weekly-notes')).toBe(false);
  });
});
