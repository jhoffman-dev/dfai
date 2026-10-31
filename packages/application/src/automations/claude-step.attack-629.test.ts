/**
 * Attack on PR #629 (#169, skills 3/5): a rule's Claude step that names a
 * skill, run over a vault in memory with a scripted model. The skill is
 * edited, deleted, renamed or made unreadable at each call the run makes to
 * the vault before Claude is asked: the model is never handed instructions
 * the run did not read whole from one SKILL.md, a skill changed before it was
 * read is read as changed, and a run that fails asks nothing and writes
 * nothing. A skill's body is handed over byte for byte as a prompt note's
 * same body is — CRLF and a byte-order mark included — and its length is the
 * prompt note's `.length` cap, with the reason named when it is over.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type AutomationRule, type ClaudeAction } from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { parseObjectType } from '@dfai/domain';
import { runAutomation } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-11';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/larkspur';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };
const STANDUP = 'Meetings/2026-10-01 Standup.md';
const PROMPT = '.atlas/prompts/meeting-actions.md';
const SKILL = '.atlas/skills/meeting-actions/SKILL.md';
const OLD = 'Find every action item Tobias Fenn took on and propose it as a task.';
const NEW = 'Find only what Mara Quill asked for, and propose nothing else.';
const DESCRIPTION = 'Pulls action items out of a meeting. Use after a standup.';
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { kind: 'text' } }),
];

const BY_PROMPT: ClaudeAction = {
  kind: 'claude',
  prompt: createVaultPath(PROMPT),
  tools: ['atlas_read_note'],
  output: { kind: 'proposals', schema: 'proposals' },
};
const BY_SKILL: ClaudeAction = {
  ...BY_PROMPT,
  prompt: createVaultPath(SKILL),
  skill: 'meeting-actions',
};
const ruleOf = (action: ClaudeAction): AutomationRule => ({
  id: 'Meeting actions',
  path: createVaultPath('.atlas/automations/Meeting actions.md'),
  name: 'Meeting actions',
  enabled: true,
  when: { kind: 'manual' },
  which: 'FROM meeting',
  olderThanDays: null,
  action,
});
const skillFile = (body: string) =>
  jsonNote({ name: 'meeting-actions', description: DESCRIPTION }, `\n${body}\n`);

const NOTES: Record<string, string> = {
  [STANDUP]: jsonNote(
    { type: 'meeting', kind: 'standup' },
    '**Mara Quill** Can you send me the payroll file by Friday? ^t0003\n',
  ),
  [PROMPT]: `---\n{"name":"x"}\n---\n${OLD}\n`,
  [SKILL]: skillFile(OLD),
};
const says = (value: unknown): ModelEvent[] => [{ type: 'text', text: JSON.stringify(value) }];

type Mutation = 'edit' | 'delete' | 'rename' | 'unreadable';

/** A run whose vault has `mutate` done to its skill just before its `at`-th call to the vault. */
async function runWithSkillChangedAt(mutation: Mutation, at: number, notes = NOTES) {
  const claude = fakeClaudeStepPorts({
    rounds: [says({ proposals: [] })],
    model: 'claude-opus-5-5',
  });
  const vault = automationVault({ notes, today: TODAY, types: TYPES, claude });
  const real = vault.ports.fs;
  let calls = 0;
  let unreadable = false;
  let readBeforeChange = false;
  let changed = false;
  const change = () => {
    changed = true;
    const text = vault.files.get(SKILL);
    if (mutation === 'edit') vault.files.set(SKILL, skillFile(NEW));
    if (mutation === 'delete') vault.files.delete(SKILL);
    if (mutation === 'rename' && text !== undefined) {
      vault.files.delete(SKILL);
      vault.files.set('.atlas/skills/meeting-notes/SKILL.md', text);
    }
    if (mutation === 'unreadable') unreadable = true;
  };
  const fs = new Proxy(real, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (calls === at && !changed) change();
        calls += 1;
        if (key === 'readTextFile' && args[0] === SKILL) {
          if (!changed) readBeforeChange = true;
          if (unreadable) throw new VaultAccessError('not allowed');
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as VaultFsPort;
  const activity = recordingActivity();
  const entry = await runAutomation({
    ports: { ...vault.ports, fs },
    rule: ruleOf(BY_SKILL),
    clock: CLOCK,
    guard: GUARD,
    activity,
    trigger: 'hand',
  });
  const written = vault.log.filter((line) => !line.includes('.atlas/automations/log/'));
  return {
    entry,
    requests: claude.fake.requests,
    written,
    changed,
    readBeforeChange,
    calls: () => calls,
  };
}

describe('a skill changed while its run is under way (#629 attack)', () => {
  const MUTATIONS: readonly Mutation[] = ['edit', 'delete', 'rename', 'unreadable'];

  it.each(MUTATIONS)(
    'never asks with what it did not read whole, the skill %s at each call to the vault',
    async (mutation) => {
      const { calls } = await runWithSkillChangedAt(mutation, Number.POSITIVE_INFINITY);
      const total = calls();
      expect(total).toBeGreaterThan(2);
      const seen = { before: 0, after: 0 };
      for (let at = 0; at <= total; at += 1) {
        const run = await runWithSkillChangedAt(mutation, at);
        const system = run.requests[0]?.system ?? '';
        if (run.requests.length > 0) {
          // One version's instructions, whole: never both, never neither.
          expect([system.includes(OLD), system.includes(NEW)]).not.toEqual([true, true]);
          expect(system.includes(OLD) || system.includes(NEW)).toBe(true);
        }
        if (run.changed) seen[run.readBeforeChange ? 'after' : 'before'] += 1;
        if (run.changed && !run.readBeforeChange) {
          // Changed before it was read: the run reads it as it now is.
          if (mutation === 'edit') {
            expect(run.requests).toHaveLength(1);
            expect(system).toContain(NEW);
          } else {
            expect(run.entry).toMatchObject({ kind: 'failed' });
            expect(run.requests).toEqual([]);
            expect(run.written).toEqual([]);
          }
        }
        if (run.entry.kind === 'failed') {
          expect(run.requests).toEqual([]);
          expect(run.written).toEqual([]);
        }
      }
      // Both sides of the read were reached, so neither half of the check is vacuous.
      expect(seen.before).toBeGreaterThan(0);
      expect(seen.after).toBeGreaterThan(0);
    },
  );
});

/** What the model is handed as its system prompt for a prompt note and a skill with the same body. */
async function systemsFor(body: string) {
  const ask = async (notes: Record<string, string>, action: ClaudeAction) => {
    const claude = fakeClaudeStepPorts({
      rounds: [says({ proposals: [] })],
      model: 'claude-opus-5-5',
    });
    const vault = automationVault({ notes, today: TODAY, types: TYPES, claude });
    const entry = await runAutomation({
      ports: vault.ports,
      rule: ruleOf(action),
      clock: CLOCK,
      guard: GUARD,
      activity: recordingActivity(),
      trigger: 'hand',
    });
    return { entry, system: claude.fake.requests[0]?.system };
  };
  const skill = await ask({ ...NOTES, [SKILL]: skillFile(body) }, BY_SKILL);
  const prompt = await ask(
    { ...NOTES, [PROMPT]: `---\n{"name":"x"}\n---\n\n${body}\n` },
    BY_PROMPT,
  );
  return { skill, prompt };
}

describe('a skill’s body as Claude is handed it, beside a prompt note’s (#629 attack)', () => {
  it.each([
    ['CRLF lines', 'Step one.\r\nStep two.\r\n\r\nStep three.'],
    ['a byte-order mark inside', 'Step one.﻿\nStep two.'],
    ['a byte-order mark first', '﻿Step one.\nStep two.'],
    ['blank lines and spaces round it', '\n\n  Step one.\n\tStep two.  \n\n'],
    ['mixed line ends', 'One.\rTwo.\nThree.\r\nFour.'],
    ['an emoji and a combining mark', 'Café́ 😀 step.'],
  ])('is byte for byte the prompt note’s, for %s', async (_label, body) => {
    const { skill, prompt } = await systemsFor(body);
    expect(skill.system).toBeDefined();
    expect(skill.system).toBe(prompt.system);
  });
});

describe('a skill’s length at the run’s cap (#629 attack)', () => {
  it.each([
    ['19,999 units', 'a'.repeat(19_999), true],
    ['20,000 units', 'a'.repeat(20_000), true],
    ['an emoji ending at 20,000', `${'a'.repeat(19_998)}😀`, true],
    ['an emoji straddling 20,000', `${'a'.repeat(19_999)}😀`, false],
  ] as const)(
    'asks or fails for %s, as a prompt note of the same body does',
    async (_l, body, asks) => {
      const { skill, prompt } = await systemsFor(body);
      expect(skill.system !== undefined).toBe(asks);
      expect(prompt.system !== undefined).toBe(asks);
    },
  );

  it('says why a skill one unit over is refused, naming its length and the cap', async () => {
    const { skill } = await systemsFor(`${'a'.repeat(19_999)}😀`);
    expect(skill.entry).toMatchObject({ kind: 'failed' });
    const problem = (skill.entry as { problem: string }).problem;
    expect(problem).toMatch(/^Its skill meeting-actions cannot be used: /);
    expect(problem).toContain('20001');
    expect(problem).toContain('20000');
  });
});
