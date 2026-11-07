import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  logPathFor,
  parseObjectType,
  parseRunLog,
  type AutomationRule,
  type ClaudeAction,
  type ModelUsage,
} from '@dfai/domain';
import { ModelProviderError, type ModelEvent } from '../chat/ports.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import type { ScriptedRound } from '../testing/fake-model.ts';
import { runAutomation } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

/**
 * Attack on PR #794 (#788): the PR says "a failed Claude Code result still
 * reports what it spent", and the adapter does emit the usage event before it
 * fails — but runChatTurn throws it away and the step records the ask as
 * unknown, so a failed run's log never holds the usage the provider gave.
 */

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
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { kind: 'text' } }),
];
const ASK: ClaudeAction = {
  kind: 'claude',
  prompt: createVaultPath(PROMPT),
  tools: ['atlas_read_note'],
  output: { kind: 'proposals', schema: 'proposals' },
};
const RULE: AutomationRule = {
  id: 'Meeting actions',
  path: createVaultPath('.atlas/automations/Meeting actions.md'),
  name: 'Meeting actions',
  enabled: true,
  when: { kind: 'manual' },
  which: 'FROM meeting',
  olderThanDays: null,
  action: ASK,
};
const NOTES = {
  [STANDUP]: jsonNote(
    { type: 'meeting', kind: 'standup' },
    '**Mara Quill** Can you send me the payroll file by Friday? ^t0003\n',
  ),
  [PROMPT]: '---\nname: x\n---\nFind every action item and propose it as a task.\n',
};
const USAGE: ModelUsage = { input: 3000, cacheCreation: 700, cacheRead: 10_000, output: 700 };

function run(rounds: readonly ScriptedRound[]) {
  const claude = fakeClaudeStepPorts({ rounds, model: 'claude-opus-5-5', stepMs: 1500 });
  const vault = automationVault({ notes: NOTES, today: TODAY, types: TYPES, claude });
  const activity = recordingActivity();
  const entry = runAutomation({
    ports: vault.ports,
    rule: RULE,
    clock: CLOCK,
    guard: GUARD,
    activity,
    trigger: 'hand',
  });
  return { entry, vault };
}

describe('a Claude step whose provider reports usage, then fails (attack #794)', () => {
  it.fails('keeps the usage the failed ask reported in its log entry', async () => {
    const { entry, vault } = run([
      async function* (): AsyncGenerator<ModelEvent> {
        yield { type: 'usage', usage: USAGE };
        throw new ModelProviderError('failed', 'Claude Code could not answer: overloaded');
      },
    ]);
    const ran = await entry;
    expect(ran).toMatchObject({ kind: 'failed', claude: { asks: 1 } });
    // Observed: claude.usage is absent; the log has no usage line.
    expect(ran).toMatchObject({ claude: { usage: USAGE } });
    const logged = parseRunLog(vault.files.get(logPathFor(RULE.id)) ?? '');
    expect(logged.at(-1)).toMatchObject({ claude: { usage: USAGE } });
  });
});
