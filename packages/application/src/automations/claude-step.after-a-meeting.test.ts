/**
 * #179 (ADR-0036, ADR-0028 addendum "The caps"): the declared step — a
 * Claude step whose rule says `apply: mine` — asks Sonnet unless its rule
 * names a model, asks at most 10 times a run, and has its own allowance of 30
 * asks an hour, apart from the 20 runs an hour every rule has. Over the fake
 * vault whose index answers with real SQL, and a scripted model.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  AUTOMATION_PRESETS,
  builtInPromptAt,
  createVaultPath,
  DECLARED_STEP_ASKS_PER_HOUR,
  DECLARED_STEP_ASKS_PER_RUN,
  DECLARED_STEP_MODEL,
  digestOf,
  logPathFor,
  newLogText,
  NOTE_RUNS_PER_HOUR,
  parseObjectType,
  parseRunLog,
  type AutomationDraft,
  type AutomationRule,
  type ClaudeAction,
  type LogEntry,
  type NoteChange,
  type VaultPath,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { MEETING_BODY, MEETING_HEADER } from '../testing/meeting-files.ts';
import { ClaudeStepFailed, runClaudeStep } from './claude-step.ts';
import { loadAutomations } from './load-automations.ts';
import { NoteRunsCappedError } from './note-runs.ts';
import { runAutomation, runOnNoteChanges } from './run-automation.ts';
import { createAutomation, updateAutomation } from './save-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };
const CHAT_MODEL = 'claude-opus-5-5';
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } }),
];

const meetingAt = (at: number): string => `Meetings/2026-10-${String(at).padStart(2, '0')} Sync.md`;
// Each meeting is one the import let in: in `Meetings`, a contract file is in play only then (#214).
const LET_IN = { ...MEETING_HEADER, atlas_import_outcome: 'imported' };
const meeting = (at: number) => jsonNote({ ...LET_IN, external_id: `gemini-${at}` }, MEETING_BODY);

/** A meeting long enough to be read in many parts: `turns` turns of about 400 characters each. */
const longMeeting = (at: number, turns: number) => {
  let body = MEETING_BODY;
  for (let id = 3; id < 3 + turns; id += 1) {
    body += `\n**Tobias Fenn** [~00:10:00] Turn ${id}. ${'word '.repeat(75)}^t${String(id).padStart(4, '0')}\n`;
  }
  return jsonNote({ ...LET_IN, external_id: `gemini-${at}` }, body);
};

const STEP: ClaudeAction = {
  kind: 'claude',
  prompt: AFTER_A_MEETING_PROMPT,
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-items' },
  apply: 'mine',
};
const RULE: AutomationRule = {
  id: 'After a meeting',
  path: createVaultPath('.atlas/automations/After a meeting.md'),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting',
  olderThanDays: null,
  action: STEP,
};

const NOTHING: ModelEvent[] = [{ type: 'text', text: JSON.stringify({ items: [] }) }];

function setUp({
  meetings = 1,
  rounds = meetings,
  turns = 0,
}: {
  meetings?: number;
  rounds?: number;
  /** When set, each meeting is a long one of this many turns. */
  turns?: number;
} = {}) {
  const claude = fakeClaudeStepPorts({
    rounds: Array.from({ length: rounds }, () => NOTHING),
    model: CHAT_MODEL,
    today: TODAY,
  });
  const notes: Record<string, string> = {
    [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
  };
  for (let at = 1; at <= meetings; at += 1) {
    notes[meetingAt(at)] = turns > 0 ? longMeeting(at, turns) : meeting(at);
  }
  const vault = automationVault({ notes, today: TODAY, types: TYPES, claude });
  const activity = recordingActivity();
  const byHand = (rule: AutomationRule) =>
    runAutomation({
      ports: vault.ports,
      rule,
      clock: CLOCK,
      guard: GUARD,
      activity,
      trigger: 'hand',
    });
  const arrived = (rule: AutomationRule, path: string) => {
    const change: NoteChange = {
      kind: 'added',
      path,
      type: 'meeting',
      digest: digestOf(vault.files.get(path) ?? ''),
    };
    return runOnNoteChanges({
      ports: vault.ports,
      rule,
      clock: CLOCK,
      guard: GUARD,
      activity,
      changes: [change],
    });
  };
  const asked = () => claude.fake.requests;
  return { claude, vault, byHand, arrived, asked };
}

/** A rule's log holding `count` runs this hour that each asked Claude `asks` times. */
const askedBefore = (rule: Pick<AutomationRule, 'id' | 'name'>, count: number, asks = 1) => {
  const entries = Array.from({ length: count }, (_, at): LogEntry => ({
    kind: 'run',
    at: `${TODAY}T08:${String(10 + at).padStart(2, '0')}:00`,
    trigger: 'note',
    done: [],
    left: [],
    capped: false,
    claude: { model: DECLARED_STEP_MODEL, ms: 10, asks },
  }));
  return [logPathFor(rule.id), newLogText(rule.name, entries)] as const;
};

describe('which model the declared step asks', () => {
  it('is Sonnet when its rule names none, whatever the chat uses', async () => {
    const { byHand, asked } = setUp();

    const entry = await byHand(RULE);

    expect(asked().map((request) => request.model)).toEqual([DECLARED_STEP_MODEL]);
    expect(entry).toMatchObject({ kind: 'run', claude: { model: DECLARED_STEP_MODEL, asks: 1 } });
  });

  it('is the model its rule names, reaching the provider’s request', async () => {
    const { byHand, asked } = setUp();

    await byHand({ ...RULE, action: { ...STEP, model: 'claude-haiku-5-5' } });

    expect(asked().map((request) => request.model)).toEqual(['claude-haiku-5-5']);
  });

  it('is the chat’s for a step that does not apply, as before', async () => {
    const { apply: _declared, ...proposalsOnly } = STEP;
    expect(_declared).toBe('mine');
    const { byHand, asked } = setUp();

    await byHand({ ...RULE, action: proposalsOnly });

    expect(asked().map((request) => request.model)).toEqual([CHAT_MODEL]);
  });
});

describe('the declared step’s asks in one run', () => {
  /** Every note is asked about alone: eleven meetings would be eleven asks. */
  const eleven = () => {
    const set = setUp({ meetings: 11 });
    const step = (action: ClaudeAction) =>
      runClaudeStep({
        ports: set.claude,
        action,
        paths: Array.from({ length: 11 }, (_, at) => createVaultPath(meetingAt(at + 1))),
        fs: set.vault.ports.fs,
        index: set.vault.ports.index,
        markdown: set.vault.ports.markdown,
        editors: set.vault.ports.editors,
        notePaths: set.vault.ports.notePaths as readonly VaultPath[],
        rule: RULE.id,
        madeBy: 'After a meeting · 2026-10-14 09:00:00',
      });
    return { ...set, step };
  };

  it('refuses the 11th: the run fails having asked ten times and written nothing', async () => {
    const { step, asked, vault } = eleven();
    const before = [...vault.files.keys()];

    const failed = await step(STEP).catch((cause: unknown) => cause);

    expect(failed).toBeInstanceOf(ClaudeStepFailed);
    expect((failed as ClaudeStepFailed).message).toBe(
      'It would ask Claude more than 10 times; one run asks at most 10.',
    );
    expect((failed as ClaudeStepFailed).claude.asks).toBe(10);
    expect(asked()).toHaveLength(10);
    expect([...vault.files.keys()]).toEqual(before);
  });
});

describe('the declared step’s hourly allowance', () => {
  it('is not spent by the shared cap: a backlog of 20 asks still lets it ask', async () => {
    const { vault, arrived, asked } = setUp();
    vault.files.set(...askedBefore(RULE, NOTE_RUNS_PER_HOUR));

    const entry = await arrived(RULE, meetingAt(1));

    expect(entry).toMatchObject({ kind: 'run', claude: { asks: 1 } });
    expect(asked()).toHaveLength(1);
  });

  it('holds the same backlog for a rule without its own allowance, as before', async () => {
    const { apply: _declared, ...proposalsOnly } = STEP;
    expect(_declared).toBe('mine');
    const plain: AutomationRule = { ...RULE, action: proposalsOnly };
    const { vault, arrived, asked } = setUp();
    vault.files.set(...askedBefore(plain, NOTE_RUNS_PER_HOUR));

    await expect(arrived(plain, meetingAt(1))).rejects.toBeInstanceOf(NoteRunsCappedError);
    expect(asked()).toHaveLength(0);
  });

  it('refuses the 31st ask of the hour, says why, and asks nothing', async () => {
    const { vault, arrived, asked } = setUp();
    vault.files.set(...askedBefore(RULE, DECLARED_STEP_ASKS_PER_HOUR));
    const logged = vault.files.get(logPathFor(RULE.id));

    const held = await arrived(RULE, meetingAt(1)).catch((cause: unknown) => cause);

    expect(held).toBeInstanceOf(NoteRunsCappedError);
    expect((held as NoteRunsCappedError).until).toBe(`${TODAY}T09:10:00`);
    expect((held as NoteRunsCappedError).hold).toEqual({
      rule: RULE.name,
      until: `${TODAY}T09:10:00`,
      runs: null,
      sharedAsks: {
        most: DECLARED_STEP_ASKS_PER_HOUR,
        asked: DECLARED_STEP_ASKS_PER_HOUR,
        by: [{ name: RULE.name, asks: DECLARED_STEP_ASKS_PER_HOUR }],
      },
    });
    expect((held as NoteRunsCappedError).message).toContain('Waiting, not broken');
    expect(asked()).toHaveLength(0);
    expect(vault.files.get(logPathFor(RULE.id))).toBe(logged);
    expect(parseRunLog(logged!)).toHaveLength(DECLARED_STEP_ASKS_PER_HOUR);
  });
});

describe('the declared step’s parts: one ask kept back for the reduce (ADR-0036)', () => {
  it('reads a meeting that needs more than 9 parts in 9 asks, and says the rest was cut', async () => {
    const { byHand, asked, vault } = setUp({ turns: 700, rounds: 10 });
    const long = vault.files.get(meetingAt(1))!;

    const entry = await byHand(RULE);

    expect(asked()).toHaveLength(DECLARED_STEP_ASKS_PER_RUN - 1);
    expect(entry).toMatchObject({
      kind: 'run',
      claude: { asks: 9, cut: [{ path: meetingAt(1), of: long.length }] },
    });
  });

  it('keeps nothing back for a step that is not declared: the same meeting takes all 10', async () => {
    const { apply: _declared, ...proposalsOnly } = STEP;
    expect(_declared).toBe('mine');
    const { byHand, asked } = setUp({ turns: 700, rounds: 10 });

    await byHand({ ...RULE, action: proposalsOnly });

    expect(asked()).toHaveLength(10);
  });
});

describe('the hourly allowance inside a run', () => {
  it('lets a run that starts at 29 asks make exactly one more, and the log says the rest was cut', async () => {
    const { byHand, asked, vault } = setUp({ turns: 120, rounds: 3 });
    vault.files.set(...askedBefore(RULE, DECLARED_STEP_ASKS_PER_HOUR - 1));

    const entry = await byHand(RULE);

    expect(asked()).toHaveLength(1);
    expect(entry).toMatchObject({
      kind: 'run',
      claude: { asks: 1, cut: [{ path: meetingAt(1) }] },
    });
  });

  it('refuses the 31st ask of the hour inside a run: it fails having asked once, writing nothing', async () => {
    const { byHand, asked, vault } = setUp({ meetings: 2 });
    vault.files.set(...askedBefore(RULE, DECLARED_STEP_ASKS_PER_HOUR - 1));
    const proposalsBefore = [...vault.files.keys()].filter((path) => !path.includes('.atlas/'));

    const entry = await byHand(RULE);

    expect(asked()).toHaveLength(1);
    expect(entry).toMatchObject({
      kind: 'failed',
      problem:
        `It would ask Claude more than ${DECLARED_STEP_ASKS_PER_HOUR} times in an hour; the rules ` +
        `that make your own action items into tasks ask at most ${DECLARED_STEP_ASKS_PER_HOUR} an hour together.`,
      claude: { asks: 1 },
    });
    expect([...vault.files.keys()].filter((path) => !path.includes('.atlas/'))).toEqual(
      proposalsBefore,
    );
  });

  it('asks nothing by hand once the hour’s 30 are spent', async () => {
    const { byHand, asked, vault } = setUp();
    vault.files.set(...askedBefore(RULE, DECLARED_STEP_ASKS_PER_HOUR));

    const entry = await byHand(RULE);

    expect(asked()).toHaveLength(0);
    expect(entry).toMatchObject({ kind: 'failed', problem: expect.stringMatching(/in an hour/) });
    expect(entry.kind === 'failed' && entry.claude?.asks).toBeUndefined();
  });
});

describe('one hourly allowance for every declared rule in the vault', () => {
  const OTHER_DRAFT = (): AutomationDraft => ({
    ...AUTOMATION_PRESETS.find((each) => each.name === 'After a meeting')!,
    name: 'After a client call',
  });
  /** A second declared rule saved in the vault, with `asks` asked this hour in its log. */
  const otherDeclaredRule = async (
    vault: ReturnType<typeof setUp>['vault'],
    asks: number,
    draft: AutomationDraft = OTHER_DRAFT(),
  ) => {
    const { fs, markdown } = vault.ports;
    await createAutomation({ fs, markdown, clock: CLOCK, draft, takenPaths: [] });
    const notePaths = [...vault.files.keys()];
    const loaded = await loadAutomations({ fs, markdown, notePaths });
    const other = loaded.automations.find((each) => each.rule.name === draft.name)!.rule;
    vault.files.set(...askedBefore(other, asks));
    return other;
  };

  it('holds a rule whose own log is under 30 when another declared rule spent the rest', async () => {
    const { vault, arrived, asked } = setUp();
    await otherDeclaredRule(vault, 20);
    vault.files.set(...askedBefore(RULE, 10));

    const held = await arrived(RULE, meetingAt(1)).catch((cause: unknown) => cause);

    expect(held).toBeInstanceOf(NoteRunsCappedError);
    // It names the rule that spent the rest, with how many each asked (#813).
    expect((held as NoteRunsCappedError).hold.sharedAsks?.by).toEqual([
      { name: RULE.name, asks: 10 },
      { name: 'After a client call', asks: 20 },
    ]);
    expect(asked()).toHaveLength(0);
  });

  it('lets it run while the two together are under 30, and asks only what is left', async () => {
    const { vault, byHand, asked } = setUp({ turns: 120, rounds: 3 });
    await otherDeclaredRule(vault, 20);
    vault.files.set(...askedBefore(RULE, 9));

    const entry = await byHand(RULE);

    expect(asked()).toHaveLength(1);
    expect(entry).toMatchObject({ kind: 'run', claude: { asks: 1 } });
  });

  it('counts the running rule’s own log once, when its file is in the vault too', async () => {
    const { vault, arrived, asked } = setUp();
    const saved = await otherDeclaredRule(vault, 15, { ...OTHER_DRAFT(), name: RULE.name });
    expect(saved.id).toBe(RULE.id);

    const entry = await arrived(RULE, meetingAt(1));

    expect(entry).toMatchObject({ kind: 'run', claude: { asks: 1 } });
    expect(asked()).toHaveLength(1);
  });

  it('does not count a rule that is not declared against it', async () => {
    const { apply: _declared, ...proposalsOnly } = STEP;
    expect(_declared).toBe('mine');
    const { vault, arrived, asked } = setUp();
    await otherDeclaredRule(vault, 25, { ...OTHER_DRAFT(), action: proposalsOnly });
    vault.files.set(...askedBefore(RULE, 10));

    const entry = await arrived(RULE, meetingAt(1));

    expect(entry).toMatchObject({ kind: 'run', claude: { asks: 1 } });
    expect(asked()).toHaveLength(1);
  });
});

describe('the "After a meeting" preset saved into a fresh vault', () => {
  const PRESET: AutomationDraft = AUTOMATION_PRESETS.find(
    (each) => each.name === 'After a meeting',
  )!;
  const SHIPPED = builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents;

  it('writes its prompt once, and the rule reads back as the preset', async () => {
    const vault = automationVault({ today: TODAY, notes: {} });
    const { fs, markdown } = vault.ports;
    const draft = { fs, markdown, clock: CLOCK };

    await createAutomation({ ...draft, draft: PRESET, takenPaths: vault.ports.notePaths });
    const loaded = await loadAutomations({ fs, markdown, notePaths: vault.ports.notePaths });
    const [rule] = loaded.automations.map((each) => each.rule);
    await updateAutomation({ ...draft, rule: rule!, draft: PRESET });

    expect(vault.files.get(AFTER_A_MEETING_PROMPT)).toBe(SHIPPED);
    expect(vault.log.filter((line) => line.includes(AFTER_A_MEETING_PROMPT))).toHaveLength(1);
    expect(rule).toMatchObject({
      name: 'After a meeting',
      which: PRESET.which,
      action: PRESET.action,
    });
    expect(loaded.broken).toEqual([]);
  });
});
