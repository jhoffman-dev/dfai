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
  readHandledLedger,
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
  /** How many answers each kept line holds: the long meeting's parts and its reduce. */
  const keptLines = () =>
    readHandledLedger(vault.files.get(logPathFor(RULE.id)) ?? null)?.stored.map(
      ({ parts }) => parts.length,
    );
  return { vault, run, spoil, keptLines };
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

describe('a retry that fails again partway (#793 re-review)', () => {
  // Kept: P1, P2, P3 and their reduce. The retry finds P2 no longer reads and fails asking it again:
  // what it keeps must still hold P3, so a third run asks P2, the reduce and the short meeting only.
  it('keeps the parts after the one it failed at', async () => {
    const { run, spoil } = setUp([
      summed('P1'),
      summed('P2'),
      summed('P3'),
      REDUCED,
      UNREADABLE,
      UNREADABLE,
      summed('P2 asked again'),
      REDUCED,
      summed('Short'),
    ]);
    expect(await run()).toMatchObject({ entry: { kind: 'failed' } });
    spoil('P2');
    expect(await run()).toMatchObject({ entry: { kind: 'failed' }, asked: { length: 1 } });

    const third = await run();

    expect(third.asked[1]).toContain(REDUCE_ASK);
    expect(third.asked).toHaveLength(3);
    expect(third.entry.kind).toBe('run');
  });

  // The spoiled P2 is not the answer the kept reduce merged, so that reduce is dropped with it; the
  // part asked again then brings its own reduce, the line holding one, not the old beside the new.
  it('keeps the parts after the one it failed at, and only the reduce of the answers it has', async () => {
    const { run, spoil, keptLines } = setUp([
      summed('P1'),
      summed('P2'),
      summed('P3'),
      REDUCED,
      UNREADABLE,
      UNREADABLE,
      summed('P2 asked again'),
      REDUCED,
      UNREADABLE,
    ]);
    expect(await run()).toMatchObject({ entry: { kind: 'failed' } });
    spoil('P2');
    expect(await run()).toMatchObject({ entry: { kind: 'failed' }, asked: { length: 1 } });
    expect(keptLines()).toEqual([3]);

    expect(await run()).toMatchObject({ entry: { kind: 'failed' }, asked: { length: 3 } });

    expect(keptLines()).toEqual([4]);
  });

  it('keeps the reduce it reused when it fails at a later meeting', async () => {
    const { run, keptLines } = setUp([
      summed('P1'),
      summed('P2'),
      summed('P3'),
      REDUCED,
      UNREADABLE,
      UNREADABLE,
      summed('Short'),
    ]);
    expect(await run()).toMatchObject({ entry: { kind: 'failed' } });
    expect(await run()).toMatchObject({ entry: { kind: 'failed' }, asked: { length: 1 } });
    expect(keptLines()).toEqual([4]);

    const third = await run();

    expect(third).toMatchObject({ entry: { kind: 'run' }, asked: { length: 1 } });
  });
});

describe('a retry after the prompt changed (#793 re-review)', () => {
  // The kept line grew from every entry kept before: after a prompt change each part's old key stayed
  // beside its new one, so a long meeting's line doubled toward STORED_ANSWERS_MAX_BYTES.
  it('keeps only the keys this run asks under', async () => {
    const { vault, run, keptLines } = setUp([
      summed('P1'),
      summed('P2'),
      summed('P3'),
      REDUCED,
      UNREADABLE,
      summed('P1 again'),
      summed('P2 again'),
      summed('P3 again'),
      REDUCED,
      UNREADABLE,
    ]);
    expect(await run()).toMatchObject({ entry: { kind: 'failed' } });
    const prompt = vault.files.get(AFTER_A_MEETING_PROMPT)!;
    vault.files.set(AFTER_A_MEETING_PROMPT, `${prompt}\nNever make a task for Tobias.\n`);

    expect(await run()).toMatchObject({ entry: { kind: 'failed' }, asked: { length: 5 } });

    expect(keptLines()).toEqual([4]);
  });
});
