/**
 * Re-review of PR #795 (#793): a retry's reduce, and what a retry that fails
 * again keeps. Over the fake vault whose index answers with real SQL and a
 * scripted model; a kept answer that no longer reads is one spoiled in the
 * rule's log, as an answer the domain now reads differently would be.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  logPathFor,
  parseObjectType,
  type AutomationRule,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import type { ScriptedRound } from '../testing/fake-model.ts';
import { MEETING_BODY, MEETING_HEADER } from '../testing/meeting-files.ts';
import { runAutomation } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const GUARD: VaultGuard = { vault: '/vaults/home', currentVault: () => '/vaults/home' };
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } }),
];
const meetingAt = (at: number) => `Meetings/2026-10-${String(at).padStart(2, '0')} Sync.md`;
/** A meeting the import let in; with `turns`, one long enough to be read in parts. */
const meeting = (at: number, turns = 0) => {
  let body = MEETING_BODY;
  for (let id = 3; id < 3 + turns; id += 1) {
    body += `\n**Tobias Fenn** [~00:10:00] Turn ${id}. ${'word '.repeat(75)}^t${String(id).padStart(4, '0')}\n`;
  }
  return jsonNote(
    { ...MEETING_HEADER, atlas_import_outcome: 'imported', external_id: `gemini-${at}` },
    body,
  );
};

const summed = (summary: string): ModelEvent[] => [
  {
    type: 'text',
    text: JSON.stringify({ summary, key_points: [summary], open_questions: [], items: [] }),
  },
];
const REDUCED: ModelEvent[] = [
  {
    type: 'text',
    text: JSON.stringify({ summary: 'Merged.', key_points: ['All'], open_questions: [] }),
  },
];
const UNREADABLE: ModelEvent[] = [{ type: 'text', text: 'Sorry, no.' }];
const REDUCE_ASK = 'One summary of a long meeting';

const RULE: AutomationRule = {
  id: 'Meeting rule',
  path: createVaultPath('.atlas/automations/Meeting rule.md'),
  name: 'Meeting rule',
  enabled: true,
  when: { kind: 'manual' },
  which: 'FROM meeting',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-items' },
    apply: 'mine',
  },
};

function setUp(rounds: readonly ScriptedRound[]) {
  const claude = fakeClaudeStepPorts({ rounds, model: 'claude-opus-5-5', today: TODAY });
  const vault = automationVault({
    notes: {
      [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
      [meetingAt(1)]: meeting(1, 105),
      [meetingAt(2)]: meeting(2),
    },
    today: TODAY,
    types: TYPES,
    claude,
  });
  /** A run by hand, and the system prompts of the asks it made. */
  const run = async () => {
    const before = claude.fake.requests.length;
    const entry = await runAutomation({
      ports: vault.ports,
      rule: RULE,
      clock: CLOCK,
      guard: GUARD,
      activity: recordingActivity(),
      trigger: 'hand',
    });
    const asked = claude.fake.requests.slice(before).map(({ system }) => system);
    return { entry, asked };
  };
  /** The kept answer whose summary is `summary`, made one that no longer reads. */
  const spoil = (summary: string) => {
    const log = logPathFor(RULE.id);
    const text = vault.files.get(log)!;
    const spoiled = text.replace(`{\\"summary\\":\\"${summary}\\"`, 'Sorry, no.');
    expect(spoiled).not.toBe(text);
    vault.files.set(log, spoiled);
  };
  return { vault, run, spoil };
}

describe('a retry that asks a long meeting’s part again (#793 re-review)', () => {
  // Kept: P1, P2, P3 and their reduce, the run failing at the next meeting. On the retry P2 no longer
  // reads and is asked again: the reduce kept was of the old P2, so it is asked again too.
  it('asks the reduce again, over the part asked again', async () => {
    const { run, spoil } = setUp([
      summed('P1'),
      summed('P2'),
      summed('P3'),
      REDUCED,
      UNREADABLE,
      summed('P2 asked again'),
      REDUCED,
      summed('Short'),
    ]);
    expect(await run()).toMatchObject({ entry: { kind: 'failed' } });
    spoil('P2');

    const retry = await run();

    expect(retry.asked[1]).toContain(REDUCE_ASK);
    expect(retry.asked[1]).toContain('Summary: P2 asked again');
    expect(retry.asked).toHaveLength(3);
    expect(retry.entry.kind).toBe('run');
  });

  it('keeps the reduce when every part it merged is reused', async () => {
    const { run } = setUp([
      summed('P1'),
      summed('P2'),
      summed('P3'),
      REDUCED,
      UNREADABLE,
      summed('Short'),
    ]);
    expect(await run()).toMatchObject({ entry: { kind: 'failed' } });

    const retry = await run();

    expect(retry.entry.kind).toBe('run');
    expect(retry.asked).toHaveLength(1);
  });
});
