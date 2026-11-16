import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  automationFrontmatter,
  automationNameProblem,
  automationPathFor,
  describeAction,
  draftProblem,
  isAutomationNote,
  isAutomationPath,
  parseAutomationRule,
  sameAutomation,
  setKeyProblem,
  setValueFromInput,
  type AutomationDraft,
} from './automation-rule.ts';
import { AUTOMATION_PRESETS, BLANK_AUTOMATION } from './presets.ts';

const PATH = createVaultPath('.atlas/automations/Tidy.md');

const RULE = {
  atlas: 'automation',
  name: 'Tidy',
  enabled: true,
  when: 'daily at 03:00',
  which: 'FROM task WHERE status = done',
  olderThanDays: 30,
  do: 'archive',
};

const problemOf = (frontmatter: Record<string, unknown>): string | null => {
  const read = parseAutomationRule(PATH, frontmatter);
  return 'broken' in read ? read.broken.problem : null;
};

describe('parseAutomationRule', () => {
  it('reads an archiving rule', () => {
    expect(parseAutomationRule(PATH, RULE)).toEqual({
      rule: {
        id: 'Tidy',
        path: PATH,
        name: 'Tidy',
        enabled: true,
        when: { kind: 'daily', at: '03:00' },
        which: 'FROM task WHERE status = done',
        olderThanDays: 30,
        action: { kind: 'archive' },
      },
      idWritten: false,
    });
  });

  it('reads a rule that sets properties to plain values', () => {
    const read = parseAutomationRule(PATH, {
      ...RULE,
      do: 'set',
      set: { status: 'done', points: 3, flagged: true },
    });
    expect('rule' in read && read.rule.action).toEqual({
      kind: 'set',
      values: { status: 'done', points: 3, flagged: true },
    });
  });

  it('is off when it does not say, and named after its file when it has no name', () => {
    const read = parseAutomationRule(PATH, { ...RULE, enabled: undefined, name: undefined });
    expect('rule' in read && read.rule.enabled).toBe(false);
    expect('rule' in read && read.rule.name).toBe('Tidy');
  });

  it('has no age filter when none is written', () => {
    const read = parseAutomationRule(PATH, { ...RULE, olderThanDays: undefined });
    expect('rule' in read && read.rule.olderThanDays).toBeNull();
    const asText = parseAutomationRule(PATH, { ...RULE, olderThanDays: '14' });
    expect('rule' in asText && asText.rule.olderThanDays).toBe(14);
  });

  it.each([
    [{ when: 'weekly' }, /Say when it runs/],
    [{ which: '  ' }, /Say which notes/],
    [{ olderThanDays: 0 }, /olderThanDays/],
    [{ olderThanDays: 2.5 }, /olderThanDays/],
    [{ olderThanDays: 4000 }, /olderThanDays/],
    [{ do: 'delete' }, /Say what it does/],
    [{ do: 'set' }, /names them under set/],
    [{ do: 'set', set: {} }, /names them under set/],
    [{ do: 'set', set: { type: 'note' } }, /DFAI keeps that one itself/],
    [{ do: 'set', set: { Archived: '2026-01-01' } }, /DFAI keeps that one itself/],
    [{ do: 'set', set: { atlas_source: 'x' } }, /DFAI keeps that one itself/],
    [{ do: 'set', set: { 'a:b': 'x' } }, /not a property a rule can set/],
    [{ do: 'set', set: { status: ['a'] } }, /to text, a number, or true or false/],
    [{ do: 'set', set: { status: '' } }, /to text, a number, or true or false/],
    [{ do: 'set', set: { status: Number.NaN } }, /to text, a number, or true or false/],
  ])('refuses %j and says why', (change, problem) => {
    expect(problemOf({ ...RULE, ...change })).toMatch(problem);
  });

  it('lists a broken rule under its own name', () => {
    const read = parseAutomationRule(PATH, { ...RULE, when: 'weekly', name: 'Weekly tidy' });
    expect('broken' in read && read.broken.name).toBe('Weekly tidy');
  });
});

describe('automationFrontmatter', () => {
  it.each<AutomationDraft>([
    ...AUTOMATION_PRESETS,
    {
      ...BLANK_AUTOMATION,
      name: 'Flag',
      which: 'FROM task',
      action: { kind: 'set', values: { flagged: true } },
    },
  ])('writes a rule that reads back as itself: %j', (draft) => {
    const frontmatter = automationFrontmatter(draft);
    expect(isAutomationNote(frontmatter)).toBe(true);
    // null is how the frontmatter writer is told to take a key out.
    const written = Object.fromEntries(
      Object.entries(frontmatter).filter(([, value]) => value !== null),
    );
    expect(parseAutomationRule(PATH, written)).toEqual({
      rule: { ...draft, id: 'Tidy', path: PATH },
      idWritten: false,
    });
  });

  it('takes out set: when the rule archives', () => {
    expect(automationFrontmatter(AUTOMATION_PRESETS[0]!)['set']).toBeNull();
  });
});

describe('sameAutomation', () => {
  const read = () => {
    const parsed = parseAutomationRule(PATH, { ...RULE, id: 'tidy' });
    if (!('rule' in parsed)) throw new Error('the rule does not read');
    return parsed.rule;
  };

  it('is the same rule read twice', () => {
    expect(sameAutomation(read(), read())).toBe(true);
  });

  it('is another rule when a key its file is written with changed', () => {
    expect(sameAutomation(read(), { ...read(), which: 'FROM task' })).toBe(false);
    expect(sameAutomation(read(), { ...read(), olderThanDays: 31 })).toBe(false);
    expect(sameAutomation(read(), { ...read(), action: { kind: 'set', values: { a: 1 } } })).toBe(
      false,
    );
  });

  it('is another rule under another id', () => {
    expect(sameAutomation(read(), { ...read(), id: 'tidy-2' })).toBe(false);
  });

  // A switch writes only `enabled` (#793): an editor open on the rule since is not refused for it.
  it('is the same rule turned on or off', () => {
    expect(sameAutomation(read(), { ...read(), enabled: false })).toBe(true);
  });
});

describe('draftProblem', () => {
  it('is null for a whole rule, and the reason for one that is not', () => {
    expect(draftProblem(AUTOMATION_PRESETS[0]!)).toBeNull();
    expect(draftProblem({ ...BLANK_AUTOMATION, name: 'x' })).toMatch(/Say which notes/);
  });
});

describe('automationNameProblem', () => {
  const taken = ['.atlas/automations/Tidy.md'];
  it.each([
    ['', 'Name the automation.'],
    ['a/b', /cannot hold/],
    ['.hidden', /cannot start with a dot/],
    ['tidy', /already an automation called “tidy”/],
  ])('refuses %j', (name, problem) => expect(automationNameProblem(name, taken)).toMatch(problem));

  it('takes a new name', () => expect(automationNameProblem('Sweep', taken)).toBeNull());
});

describe('paths', () => {
  it('keeps a rule directly in the automations folder', () => {
    expect(automationPathFor(' Tidy ')).toBe('.atlas/automations/Tidy.md');
    expect(isAutomationPath('.atlas/automations/Tidy.md')).toBe(true);
    expect(isAutomationPath('.atlas/automations/log/Tidy.md')).toBe(false);
    expect(isAutomationPath('.atlas/automations/Tidy.txt')).toBe(false);
    expect(isAutomationPath('automations/Tidy.md')).toBe(false);
  });
});

describe('describeAction', () => {
  it('says what a rule does', () => {
    expect(describeAction({ kind: 'archive' })).toBe('Archive');
    expect(describeAction({ kind: 'set', values: { status: 'done', points: 3 } })).toBe(
      'Set status to done, points to 3',
    );
  });
});

describe('setKeyProblem', () => {
  it('lets an ordinary property through', () => {
    expect(setKeyProblem('status')).toBeNull();
    expect(setKeyProblem('Due date')).toBeNull();
  });
});

describe('setValueFromInput', () => {
  it.each([
    ['true', true],
    [' false ', false],
    ['3', 3],
    ['-2.5', -2.5],
    ['done', 'done'],
    ['007x', '007x'],
    ['1e3', '1e3'],
    ['True', 'True'],
  ])('reads %j as %j', (typed, value) => expect(setValueFromInput(typed)).toBe(value));
});
