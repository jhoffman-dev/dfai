/**
 * The morning brief (#39): the ready-made rule run as the app runs it — a
 * vault in memory with a real-SQL index, event notes as a meetings sync
 * writes them (ADR-0046), a scripted model and a fixed clock. Each of today's
 * meetings with a linked person or company gets one brief in
 * `Inbox/Briefs/<day>/`, handed what `brief()` says of them and citing it,
 * however often the rule runs.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PRESETS,
  createVaultPath,
  logPathFor,
  parseRunLog,
  type AutomationRule,
  type LogEntry,
} from '@dfai/domain';
import { ModelProviderError, type ModelEvent } from '../chat/ports.ts';
import {
  ASSISTANT_FILES,
  ASSISTANT_TODAY,
  ASSISTANT_TYPES,
  jsonNote,
  LARKSPUR,
  MARA,
  TOBIAS,
} from '../testing/assistant-vault.ts';
import { automationVault } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import { jsonMarkdown } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import type { ScriptedRound } from '../testing/fake-model.ts';
import { runAutomation, type AutomationPorts } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = ASSISTANT_TODAY;
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };
const PRESET = AUTOMATION_PRESETS.find((each) => each.name === 'Morning brief')!;
const RULE: AutomationRule = {
  ...PRESET,
  id: 'Morning brief',
  path: createVaultPath('.atlas/automations/Morning brief.md'),
};
const FOLDER = `Inbox/Briefs/${TODAY}`;
const SYNC = `Calendar/${TODAY} Larkspur sync.md`;
const VENDOR = `Calendar/${TODAY} Vendor call.md`;

const event = (properties: Record<string, unknown>) =>
  jsonNote({ type: 'event', gcal_calendar: 'primary', gcal_response: 'accepted', ...properties });

const NOTES: Record<string, string> = {
  ...ASSISTANT_FILES,
  '.atlas/prompts/morning-brief.md': 'Brief the meeting.\n',
  [SYNC]: event({
    title: 'Larkspur sync',
    date: `${TODAY}T09:30`,
    ends: `${TODAY}T10:00`,
    gcal_event_id: 'ev-sync',
    people: ['[[People/Mara Quill]]'],
    companies: ['[[Companies/Larkspur Payroll]]'],
  }),
  [VENDOR]: event({
    title: 'Vendor call',
    date: `${TODAY}T11:00`,
    gcal_event_id: 'ev-vendor',
    people: ['[[People/Tobias Fenn]]'],
  }),
  [`Calendar/${TODAY} Declined review.md`]: event({
    title: 'Declined review',
    date: `${TODAY}T13:00`,
    gcal_event_id: 'ev-declined',
    gcal_response: 'declined',
    people: ['[[People/Mara Quill]]'],
  }),
  [`Calendar/${TODAY} Cancelled lunch.md`]: event({
    title: 'Cancelled lunch',
    date: `${TODAY}T12:00`,
    gcal_event_id: 'ev-cancelled',
    gcal_missing: true,
    people: ['[[People/Mara Quill]]'],
  }),
  [`Calendar/${TODAY} Focus time.md`]: event({
    title: 'Focus time',
    date: `${TODAY}T15:00`,
    gcal_event_id: 'ev-focus',
  }),
};

const says = (value: unknown): ModelEvent[] => [{ type: 'text', text: JSON.stringify(value) }];
/** A brief citing `cited`, and one item citing nothing, which DFAI leaves out. */
const brief = (cited: string): ModelEvent[] =>
  says({
    note: {
      title: 'Whatever Claude calls it',
      body: `## Who\n\n- Where things stand: [[${cited}]]\n- A claim citing nothing\n`,
    },
  });

function setUp(rounds: readonly ScriptedRound[], notes: Record<string, string> = NOTES) {
  let day = TODAY;
  let time = '07:00:00';
  const clock = {
    today: () => day,
    localNow: () => `${day}T${time}`,
    now: () => Date.parse(`${day}T${time}Z`),
  };
  const claude = fakeClaudeStepPorts({ rounds, model: 'claude-test', today: TODAY });
  const vault = automationVault({ notes, today: TODAY, types: ASSISTANT_TYPES, claude });
  // The vault's notes as the host's index holds them when the run starts: relations resolved, today pinned.
  const query = atlasQueryIndex({ files: notes, markdown: jsonMarkdown() });
  const ports: AutomationPorts = {
    ...vault.ports,
    index: fakeIndexPort({
      query: async (sql, parameters) =>
        query(sql.replaceAll("date('now', 'localtime'", `date('${TODAY}'`), parameters),
    }),
    claude: { ...claude, clock: { today: clock.today, now: clock.now } },
  };
  const activity = recordingActivity();
  const run = (at: { day?: string; time: string }, trigger: 'schedule' | 'hand' = 'schedule') => {
    day = at.day ?? day;
    time = at.time;
    return runAutomation({ ports, rule: RULE, clock, guard: GUARD, activity, trigger });
  };
  const briefs = () => [...vault.files.keys()].filter((path) => path.startsWith('Inbox/Briefs/'));
  const logOf = (): LogEntry[] => parseRunLog(vault.files.get(logPathFor(RULE.id)) ?? '');
  return { claude, vault, run, briefs, logOf, activity, asked: () => claude.fake.requests.length };
}

describe('the Morning brief preset', () => {
  it('is daily at 07:00, writes notes into the Inbox, and is handed each meeting’s briefs', () => {
    expect(PRESET).toMatchObject({
      when: { kind: 'daily', at: '07:00' },
      which: '',
      action: {
        kind: 'claude',
        output: { kind: 'note', folder: 'Inbox/Briefs' },
        data: 'meeting-briefs',
      },
    });
  });

  it('writes one brief per meeting with a linked person or company, each citing its sources', async () => {
    const { run, briefs, vault, claude, asked } = setUp([brief(MARA), brief(TOBIAS)]);
    await run({ time: '07:00:00' });

    // The declined, the cancelled and the meeting with nobody linked get none.
    expect(briefs().sort()).toEqual([
      `${FOLDER}/09.30 Larkspur sync.md`,
      `${FOLDER}/11.00 Vendor call.md`,
    ]);
    expect(asked()).toBe(2);
    const sync = vault.files.get(`${FOLDER}/09.30 Larkspur sync.md`)!;
    expect(sync).toContain('"atlas_period":"2999-03-13T07:00:00"');
    expect(sync).toContain('"atlas_period_item":"gcal:ev-sync"');
    expect(sync).toContain('"atlas_period_rule":"Morning brief"');
    // What cites a note it was handed is kept; what cites nothing is left out.
    expect(sync).toContain(`- Where things stand: [[${MARA}]]`);
    expect(sync).not.toContain('A claim citing nothing');

    // Each ask is about its own meeting, handed what brief() says of who is met there.
    const [first, second] = claude.fake.requests.map((request) => request.system);
    expect(first).toContain(`- [[${SYNC}]] Larkspur sync — today 09:30–10:00`);
    expect(first).toContain(`- [[${MARA}]] Mara Quill`);
    expect(first).toContain(`- [[${LARKSPUR}]] Larkspur Payroll`);
    expect(first).toContain('[[Meetings/Cut-over review.md]]');
    expect(first).not.toContain(VENDOR);
    expect(second).toContain(`- [[${TOBIAS}]] Tobias Fenn`);
    expect(second).not.toContain(`[[${MARA}]]`);
  });

  it('creates nothing new when run again the same day, on time, later or by hand', async () => {
    const { run, briefs, asked, logOf } = setUp([brief(MARA), brief(TOBIAS)]);
    await run({ time: '07:00:00' });
    const before = briefs().sort();
    const again = await run({ time: '08:15:00' });
    await run({ time: '17:00:00' }, 'hand');

    expect(briefs().sort()).toEqual(before);
    expect(asked()).toBe(2);
    expect(again).toMatchObject({ kind: 'run', done: [], period: { slot: `${TODAY}T07:00:00` } });
    expect(logOf().filter((entry) => entry.kind === 'run' && entry.done.length > 0)).toHaveLength(
      2,
    );
  });

  it('counts a brief synced in from the other Mac as made, by its own properties', async () => {
    const synced = jsonNote(
      {
        atlas_period: `${TODAY}T07:00:00`,
        atlas_period_item: 'gcal:ev-sync',
        atlas_period_rule: 'Morning brief',
      },
      'Brief.\n',
    );
    const { run, briefs, asked } = setUp([brief(TOBIAS)], {
      ...NOTES,
      [`${FOLDER}/09.30 Larkspur sync.md`]: synced,
    });
    await run({ time: '07:00:00' });

    expect(asked()).toBe(1);
    expect(briefs().sort()).toEqual([
      `${FOLDER}/09.30 Larkspur sync.md`,
      `${FOLDER}/11.00 Vendor call.md`,
    ]);
  });

  it('writes nothing when the brief syncs in from the other Mac while Claude is asked', async () => {
    const synced = jsonNote(
      {
        atlas_period: `${TODAY}T07:00:00`,
        atlas_period_item: 'gcal:ev-sync',
        atlas_period_rule: 'Morning brief',
      },
      'Brief from the other Mac.\n',
    );
    let files: Map<string, string> | null = null;
    const arriving = async function* () {
      files!.set(`Inbox/Briefs/${TODAY}/Synced.md`, synced);
      yield* brief(MARA);
    };
    const set = setUp([arriving, brief(TOBIAS)]);
    files = set.vault.files;
    await set.run({ time: '07:00:00' });

    expect(set.asked()).toBe(2);
    expect(set.briefs().sort()).toEqual([`${FOLDER}/11.00 Vendor call.md`, `${FOLDER}/Synced.md`]);
    expect(
      set.logOf().filter((entry) => entry.kind === 'run' && entry.done.length > 0),
    ).toHaveLength(1);
  });

  it('still briefs the other meetings when the provider fails on one, and says so once', async () => {
    const { run, briefs, logOf, activity } = setUp([
      new ModelProviderError('failed', 'Claude is not responding'),
      brief(TOBIAS),
    ]);
    await run({ time: '07:00:00' });

    expect(briefs()).toEqual([`${FOLDER}/11.00 Vendor call.md`]);
    const failed = logOf().filter((entry) => entry.kind === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      problem: expect.stringContaining('No brief for “Larkspur sync”'),
    });
    const errors = activity.reports.filter((report) => report.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Larkspur sync');
    expect(activity.reports).toHaveLength(2);
  });

  it('briefs nothing when today has no meeting with a linked person or company', async () => {
    const quiet = Object.fromEntries(
      Object.entries(NOTES).filter(([path]) => path !== SYNC && path !== VENDOR),
    );
    const { run, briefs, asked } = setUp([], quiet);
    const entry = await run({ time: '07:00:00' });

    expect(briefs()).toEqual([]);
    expect(asked()).toBe(0);
    expect(entry).toMatchObject({ kind: 'run', done: [] });
  });

  it('catches up a 07:00 slept through later the same day, and never yesterday’s', async () => {
    const late = setUp([brief(MARA), brief(TOBIAS)]);
    await late.run({ time: '10:40:00' });
    expect(late.briefs()).toHaveLength(2);

    // Asleep from before 07:00 until just before the next 07:00: the missed slot is yesterday's.
    const next = setUp([brief(MARA), brief(TOBIAS)]);
    await next.run({ day: '2999-03-14', time: '06:30:00' });
    expect(next.asked()).toBe(0);
    expect(next.briefs()).toEqual([]);
  });

  it('never writes over a note already there: a brief takes the next free name', async () => {
    const mine = jsonNote({}, 'My own prep.\n');
    const { run, vault } = setUp([brief(MARA), brief(TOBIAS)], {
      ...NOTES,
      [`${FOLDER}/09.30 Larkspur sync.md`]: mine,
    });
    await run({ time: '07:00:00' });

    expect(vault.files.get(`${FOLDER}/09.30 Larkspur sync.md`)).toBe(mine);
    expect(vault.files.get(`${FOLDER}/09.30 Larkspur sync 2.md`)).toContain('gcal:ev-sync');
  });

  it('does not bring back a brief deleted after it was made, unless run by hand', async () => {
    const { run, briefs, vault, asked } = setUp([brief(MARA), brief(TOBIAS), brief(MARA)]);
    await run({ time: '07:00:00' });
    vault.files.delete(`${FOLDER}/09.30 Larkspur sync.md`);
    await run({ time: '09:00:00' });
    expect(asked()).toBe(2);

    await run({ time: '09:05:00' }, 'hand');
    expect(asked()).toBe(3);
    expect(briefs().sort()).toEqual([
      `${FOLDER}/09.30 Larkspur sync.md`,
      `${FOLDER}/11.00 Vendor call.md`,
    ]);
  });

  it('briefs at most ten meetings in one run and says the rest wait for Run now', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 11 }, (_, at) => {
        const hour = String(8 + at).padStart(2, '0');
        return [
          `Calendar/${TODAY} Call ${hour}.md`,
          event({
            title: `Call ${hour}`,
            date: `${TODAY}T${hour}:00`,
            gcal_event_id: `ev-${hour}`,
            people: ['[[People/Mara Quill]]'],
          }),
        ];
      }),
    );
    const quiet = Object.fromEntries(
      Object.entries(NOTES).filter(([path]) => path !== SYNC && path !== VENDOR),
    );
    const { run, briefs, asked } = setUp(
      Array.from({ length: 11 }, () => brief(MARA)),
      { ...quiet, ...many },
    );
    const last = await run({ time: '07:00:00' });

    expect(asked()).toBe(10);
    expect(briefs()).toHaveLength(10);
    expect(last).toMatchObject({
      kind: 'run',
      left: [{ path: `Calendar/${TODAY} Call 18.md`, reason: expect.stringContaining('Run now') }],
    });
  });
});
