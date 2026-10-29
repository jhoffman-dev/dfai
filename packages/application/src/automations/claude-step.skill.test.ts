/**
 * A rule's Claude step that names a skill (#169, ADR-0050, ADR-0028's
 * amendment), run over a vault held in memory with a scripted model in
 * place of Claude. It asks with the skill's instructions — SKILL.md's body,
 * never its frontmatter — exactly as a prompt note's body is asked with; a
 * skill that is gone or breaks a skill's rules fails the run, asks nothing
 * and writes nothing. A rule with a prompt runs as it always has.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  logPathFor,
  parseObjectType,
  parseRunLog,
  type AutomationRule,
  type ClaudeAction,
  type LogEntry,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import type { ScriptedRound } from '../testing/fake-model.ts';
import { runAutomation } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-11';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };
const STANDUP = 'Meetings/2026-10-01 Standup.md';
const PROMPT = '.atlas/prompts/meeting-actions.md';
const SKILL = '.atlas/skills/meeting-actions/SKILL.md';
const INSTRUCTIONS = 'Find every action item Tobias Fenn took on and propose it as a task.';
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

const skillFile = (frontmatter: Record<string, unknown>, body = `\n${INSTRUCTIONS}\n`) =>
  jsonNote(frontmatter, body);
const GOOD_SKILL = skillFile({ name: 'meeting-actions', description: DESCRIPTION });

const NOTES = {
  [STANDUP]: jsonNote(
    { type: 'meeting', kind: 'standup' },
    '**Mara Quill** Can you send me the payroll file by Friday? ^t0003\n',
  ),
  [PROMPT]: `---\nname: x\n---\n${INSTRUCTIONS}\n`,
  [SKILL]: GOOD_SKILL,
};

/** The vault's notes with no SKILL.md. */
const withoutSkill = () =>
  Object.fromEntries(Object.entries(NOTES).filter(([path]) => path !== SKILL));

const says = (value: unknown): ModelEvent[] => [{ type: 'text', text: JSON.stringify(value) }];

function setUp({
  rounds = [says({ proposals: [] })],
  notes = NOTES,
}: {
  rounds?: readonly ScriptedRound[];
  notes?: Record<string, string>;
} = {}) {
  const claude = fakeClaudeStepPorts({ rounds, model: 'claude-opus-5-5', stepMs: 1500 });
  const vault = automationVault({ notes, today: TODAY, types: TYPES, claude });
  const activity = recordingActivity();
  const run = (action: ClaudeAction) =>
    runAutomation({
      ports: vault.ports,
      rule: ruleOf(action),
      clock: CLOCK,
      guard: GUARD,
      activity,
      trigger: 'hand',
    });
  const logOf = (): LogEntry[] => parseRunLog(vault.files.get(logPathFor('Meeting actions')) ?? '');
  const written = () => vault.log.filter((line) => !line.includes('.atlas/automations/log/'));
  return { claude, vault, activity, run, logOf, written };
}

describe('a Claude step that names a skill', () => {
  it('asks with the skill’s instructions, and none of its frontmatter', async () => {
    const { claude, run } = setUp();

    const entry = await run(BY_SKILL);

    expect(entry).toMatchObject({ kind: 'run' });
    expect(claude.fake.requests).toHaveLength(1);
    const system = claude.fake.requests[0]?.system ?? '';
    expect(system).toContain(INSTRUCTIONS);
    expect(system).not.toContain(DESCRIPTION);
    expect(system).not.toContain('"name":"meeting-actions"');
    expect(system).toContain(`<vault_data note="${STANDUP}">`);
  });

  it('is asked exactly as a prompt note with the same instructions is', async () => {
    const bySkill = setUp();
    await bySkill.run(BY_SKILL);
    const byPrompt = setUp();
    await byPrompt.run(BY_PROMPT);

    const [skillAsk] = bySkill.claude.fake.requests;
    const [promptAsk] = byPrompt.claude.fake.requests;
    expect(skillAsk?.system).toBeDefined();
    expect(skillAsk?.system).toBe(promptAsk?.system);
    expect(skillAsk?.messages).toEqual(promptAsk?.messages);
  });

  it('writes what the model answers, as any Claude step does', async () => {
    const { run, written } = setUp({
      rounds: [
        says({
          proposals: [
            {
              kind: 'task',
              title: 'Send Mara the payroll file',
              properties: { status: 'next' },
              source: '[[2026-10-01 Standup#^t0003]]',
              confidence: 'high',
              why: 'Mara asked for it on the call.',
            },
          ],
        }),
      ],
    });

    await run(BY_SKILL);

    expect(written()).toEqual(['create Inbox/Proposals/Send Mara the payroll file.md']);
  });
});

describe('a skill that cannot be asked with fails the run, asking and writing nothing', () => {
  async function failsWith(notes: Record<string, string>, problem: string, action = BY_SKILL) {
    const step = setUp({ notes });
    const entry = await step.run(action);
    expect(entry).toMatchObject({ kind: 'failed', trigger: 'hand', problem });
    expect(step.written()).toEqual([]);
    expect(step.claude.fake.requests).toEqual([]);
    expect(step.logOf()).toEqual([entry]);
    expect(step.activity.reports[0]).toMatchObject({ level: 'error' });
  }

  it('fails for a skill that is not there', async () => {
    const notes = withoutSkill();
    await failsWith(notes, 'Its skill meeting-actions is not in .atlas/skills.');
  });

  it('fails for a skill folder with no SKILL.md', async () => {
    const notes = withoutSkill();
    await failsWith(
      { ...notes, '.atlas/skills/meeting-actions/notes.txt': 'kept' },
      'Its skill meeting-actions cannot be used: The folder has no SKILL.md.',
    );
  });

  it('fails for a skill with no description, saying what is wrong', async () => {
    await failsWith(
      { ...NOTES, [SKILL]: skillFile({ name: 'meeting-actions' }) },
      'Its skill meeting-actions cannot be used: Say what the skill does and when to use it.',
    );
  });

  it('fails for a skill whose name: is another’s', async () => {
    const step = setUp({
      notes: { ...NOTES, [SKILL]: skillFile({ name: 'other', description: DESCRIPTION }) },
    });
    const entry = await step.run(BY_SKILL);
    expect(entry).toMatchObject({
      kind: 'failed',
      problem: expect.stringMatching(/^Its skill meeting-actions cannot be used: /),
    });
    expect(step.claude.fake.requests).toEqual([]);
  });

  it('fails for instructions over the 20,000-character cap', async () => {
    await failsWith(
      {
        ...NOTES,
        [SKILL]: skillFile(
          { name: 'meeting-actions', description: DESCRIPTION },
          `\n${'a'.repeat(20_001)}\n`,
        ),
      },
      'Its skill meeting-actions cannot be used: A skill’s instructions may be at most 20000 characters.',
    );
  });

  it('asks with instructions at the cap, their last line end counted as the rule counts it', async () => {
    const step = setUp({
      notes: {
        ...NOTES,
        [SKILL]: skillFile(
          { name: 'meeting-actions', description: DESCRIPTION },
          `\n${'a'.repeat(19_999)}\n`,
        ),
      },
    });
    await step.run(BY_SKILL);
    expect(step.claude.fake.requests[0]?.system).toContain('a'.repeat(19_999));
  });

  it('fails for blank instructions', async () => {
    await failsWith(
      {
        ...NOTES,
        [SKILL]: skillFile({ name: 'meeting-actions', description: DESCRIPTION }, '\n  \n'),
      },
      'Its skill meeting-actions cannot be used: Write the skill’s instructions.',
    );
  });

  it('fails, in DFAI’s own words, when .atlas/skills is there but cannot be listed', async () => {
    const step = setUp();
    const { fs } = step.vault.ports;
    const entry = await runAutomation({
      ports: {
        ...step.vault.ports,
        fs: {
          ...fs,
          listDirectory: async (parent) => {
            if (parent === '.atlas/skills') {
              throw new VaultAccessError('/Users/mara/vault/.atlas/skills: permission denied');
            }
            return fs.listDirectory(parent);
          },
        },
      },
      rule: ruleOf(BY_SKILL),
      clock: CLOCK,
      guard: GUARD,
      activity: step.activity,
      trigger: 'hand',
    });
    expect(entry).toMatchObject({
      kind: 'failed',
      problem: 'Its skill meeting-actions could not be read.',
    });
    expect(step.claude.fake.requests).toEqual([]);
    expect(step.written()).toEqual([]);
  });

  it('refuses a step whose prompt is not its own skill’s SKILL.md', async () => {
    await failsWith(NOTES, 'Its skill "meeting-actions" is not a skill in .atlas/skills.', {
      ...BY_SKILL,
      prompt: createVaultPath('.atlas/skills/other/SKILL.md'),
    });
    await failsWith(NOTES, 'Its skill "meeting-actions" is not a skill in .atlas/skills.', {
      ...BY_SKILL,
      prompt: createVaultPath(PROMPT),
    });
  });
});

describe('a Claude step that names a prompt, beside skills', () => {
  it('reads its prompt note, never the skill of the same name', async () => {
    const step = setUp({
      notes: {
        ...NOTES,
        [SKILL]: skillFile(
          { name: 'meeting-actions', description: DESCRIPTION },
          '\nThe skill’s own words.\n',
        ),
      },
    });
    await step.run(BY_PROMPT);
    const system = step.claude.fake.requests[0]?.system ?? '';
    expect(system).toContain(INSTRUCTIONS);
    expect(system).not.toContain('The skill’s own words.');
  });

  it('still refuses a SKILL.md named as its prompt, in the same words', async () => {
    const step = setUp();
    const entry = await step.run({ ...BY_PROMPT, prompt: createVaultPath(SKILL) });
    expect(entry).toMatchObject({
      kind: 'failed',
      problem: `Its prompt "${SKILL}" is not a note in .atlas/prompts.`,
    });
    expect(step.claude.fake.requests).toEqual([]);
  });
});
