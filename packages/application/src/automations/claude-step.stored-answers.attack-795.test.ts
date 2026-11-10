/**
 * Attack on PR #795 (#793): the answers a failed run kept, reused by its
 * retry. Over the fake vault whose index answers with real SQL and a scripted
 * model. Each test is a bug found, an `it.fails` until it was fixed.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  parseObjectType,
  type AutomationRule,
  type ClaudeAction,
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
const LET_IN = { ...MEETING_HEADER, atlas_import_outcome: 'imported' };
const meetingAt = (at: number) => `Meetings/2026-10-${String(at).padStart(2, '0')} Sync.md`;
/** A meeting the import let in; with `turns`, one long enough to be read in parts. */
const meeting = (at: number, turns = 0) => {
  let body = MEETING_BODY;
  for (let id = 3; id < 3 + turns; id += 1) {
    body += `\n**Tobias Fenn** [~00:10:00] Turn ${id}. ${'word '.repeat(75)}^t${String(id).padStart(4, '0')}\n`;
  }
  return jsonNote({ ...LET_IN, external_id: `gemini-${at}` }, body);
};

const NOTHING: ModelEvent[] = [{ type: 'text', text: JSON.stringify({ items: [] }) }];
const SUMMED: ModelEvent[] = [
  {
    type: 'text',
    text: JSON.stringify({
      summary: 'They agreed to ship the cache behind a flag.',
      key_points: ['The cache is ready'],
      open_questions: [],
      items: [],
    }),
  },
];
const UNREADABLE: ModelEvent[] = [{ type: 'text', text: 'Sorry, no.' }];

const EXTRACTION: ClaudeAction = {
  kind: 'claude',
  prompt: AFTER_A_MEETING_PROMPT,
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-items' },
};
const DECLARED: ClaudeAction = { ...EXTRACTION, apply: 'mine' };
const ruleOf = (action: ClaudeAction): AutomationRule => ({
  id: 'Meeting rule',
  path: createVaultPath('.atlas/automations/Meeting rule.md'),
  name: 'Meeting rule',
  enabled: true,
  when: { kind: 'manual' },
  which: 'FROM meeting',
  olderThanDays: null,
  action,
});

function setUp(rounds: readonly ScriptedRound[], notes: Record<string, string>) {
  const claude = fakeClaudeStepPorts({ rounds, model: 'claude-opus-5-5', today: TODAY });
  const vault = automationVault({
    notes: {
      [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
      ...notes,
    },
    today: TODAY,
    types: TYPES,
    claude,
  });
  const byHand = (rule: AutomationRule) =>
    runAutomation({
      ports: vault.ports,
      rule,
      clock: CLOCK,
      guard: GUARD,
      activity: recordingActivity(),
      trigger: 'hand',
    });
  /** How many asks a run made, counted from the model's requests. */
  const asksOf = async (rule: AutomationRule) => {
    const before = claude.fake.requests.length;
    const entry = await byHand(rule);
    return { entry, asks: claude.fake.requests.length - before };
  };
  return { vault, asksOf };
}

describe('a retry after a long meeting failed partway (#793 attack)', () => {
  // The PR and ADR-0036's amendment say "a retry asks nothing it already asked". Parts are kept only
  // once every part of a meeting read: parts 1 and 2 that read are thrown away with the failure.
  it('asks only the part that failed, not the parts that already read', async () => {
    const { asksOf } = setUp([NOTHING, NOTHING, UNREADABLE, NOTHING, NOTHING, NOTHING], {
      [meetingAt(1)]: meeting(1, 105),
    });
    const first = await asksOf(ruleOf(EXTRACTION));
    expect(first).toMatchObject({ entry: { kind: 'failed' }, asks: 3 });

    const retry = await asksOf(ruleOf(EXTRACTION));

    expect(retry.entry.kind).toBe('run');
    expect(retry.asks).toBe(1);
  });

  it('keeps the parts a failed retry reused, so a third run asks only the part still owed', async () => {
    const { asksOf } = setUp([NOTHING, NOTHING, UNREADABLE, UNREADABLE, NOTHING, NOTHING], {
      [meetingAt(1)]: meeting(1, 105),
    });
    expect(await asksOf(ruleOf(EXTRACTION))).toMatchObject({ entry: { kind: 'failed' }, asks: 3 });
    expect(await asksOf(ruleOf(EXTRACTION))).toMatchObject({ entry: { kind: 'failed' }, asks: 1 });

    const third = await asksOf(ruleOf(EXTRACTION));

    expect(third.entry.kind).toBe('run');
    expect(third.asks).toBe(1);
  });
});

describe('the declared step’s kept answers after its prompt or model changed (#793 attack)', () => {
  // askedParts (claude-step.ts) leaves the model and prompt digest out for `apply: mine`, but the declared
  // step's prompt is a vault note the person edits (readPrompt) and its model is the rule's `model`.
  it('asks again about a meeting it kept an answer for when its prompt was edited since', async () => {
    const { vault, asksOf } = setUp([NOTHING, UNREADABLE, NOTHING, NOTHING], {
      [meetingAt(1)]: meeting(1),
      [meetingAt(2)]: meeting(2),
    });
    expect((await asksOf(ruleOf(DECLARED))).entry.kind).toBe('failed');
    const prompt = vault.files.get(AFTER_A_MEETING_PROMPT)!;
    vault.files.set(AFTER_A_MEETING_PROMPT, `${prompt}\nNever make a task for Tobias.\n`);

    const retry = await asksOf(ruleOf(DECLARED));

    expect(retry.entry.kind).toBe('run');
    expect(retry.asks).toBe(2);
  });

  it('asks again about a meeting it kept an answer for when its model changed since', async () => {
    const { asksOf } = setUp([NOTHING, UNREADABLE, NOTHING, NOTHING], {
      [meetingAt(1)]: meeting(1),
      [meetingAt(2)]: meeting(2),
    });
    expect((await asksOf(ruleOf(DECLARED))).entry.kind).toBe('failed');

    const retry = await asksOf(ruleOf({ ...DECLARED, model: 'claude-haiku-5-5' }));

    expect(retry.entry.kind).toBe('run');
    expect(retry.asks).toBe(2);
  });
});

describe('a rule that is not declared, with a summarising schema (#793 attack)', () => {
  // rereadKept owes a reduce on `schema.summarises`, but reduceParts asks one only for `apply: mine`:
  // a long meeting's kept parts never match, so the retry asks every part again.
  it('reuses a long meeting’s kept parts on the retry', async () => {
    const digest = {
      ...EXTRACTION,
      output: { kind: 'proposals', schema: 'meeting-digest' },
    } as const;
    const { asksOf } = setUp([SUMMED, SUMMED, SUMMED, UNREADABLE, SUMMED, SUMMED, SUMMED, SUMMED], {
      [meetingAt(1)]: meeting(1, 105),
      [meetingAt(2)]: meeting(2),
    });
    expect(await asksOf(ruleOf(digest))).toMatchObject({ entry: { kind: 'failed' }, asks: 4 });

    const retry = await asksOf(ruleOf(digest));

    expect(retry.entry.kind).toBe('run');
    expect(retry.asks).toBe(1);
  });
});
