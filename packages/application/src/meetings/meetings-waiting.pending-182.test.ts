import { describe, expect, it, vi } from 'vitest';
import {
  createVaultPath,
  NO_POST_PROCESSING,
  splitFrontmatter,
  type CountableStanding,
  type MeetingsWaiting,
  type PostProcessingLedger,
  type VaultPath,
  type WaitingCountGate,
} from '@dfai/domain';
import { postProcessingKeyOf } from '../automations/post-processing-ledger.ts';
import { automationVault } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { MEETING_HEADER, meetingFile } from '../testing/meeting-files.ts';
import { createMeetingImporter } from './meeting-importer.ts';
import type { MeetingsWaitingWatch } from './meetings-waiting.ts';

/**
 * #182 (ADR-0035 parts 1 and 3): the waiting count adds the meetings the
 * import let in whose summary and tasks are still pending in the rule's
 * ledger, and the Mac that runs the automations says — once per failure —
 * when its own step cannot reach Claude.
 */

const VAULT = '/Users/j/Vault';
const TODAY = '2026-10-08';
const UNSTAMPED = 'Inbox/Meetings/2026-10-06 Standup.md';
const PENDING = 'Meetings/2026/10/2026-10-07 Platform sync.md';
const ANSWERED = 'Meetings/2026/10/2026-10-05 Vendor call.md';
const NOT_LOGGED_IN = 'Claude Code is installed but not logged in. Fix: claude auth login';

const PULL: CountableStanding = {
  kind: 'pulled',
  startedAsleepMs: 0,
  finishedAt: Date.parse(`${TODAY}T13:00:00Z`),
  namedAfter: false,
};

const imported = (externalId: string) =>
  meetingFile({ ...MEETING_HEADER, external_id: externalId, atlas_import_outcome: 'imported' });

const NOTES: Record<string, string> = {
  [UNSTAMPED]: meetingFile(),
  [PENDING]: imported('gemini-pending'),
  [ANSWERED]: imported('gemini-answered'),
};

/** The "After a meeting" rule on, having answered the vendor call alone. */
const LEDGER: PostProcessingLedger = {
  summarising: true,
  from: '2026-09-24',
  answered: new Set([ANSWERED]),
  stored: new Set(),
};

function setUp({
  named = { name: 'Studio' } as { name: string | null } | null,
  importing = false,
}: { named?: { name: string | null } | null; importing?: boolean } = {}) {
  // The Mac that imports has imported everything: what is left is the step's.
  const notes = importing
    ? Object.fromEntries(Object.entries(NOTES).filter(([path]) => path !== UNSTAMPED))
    : NOTES;
  const vault = automationVault({ notes, today: TODAY });
  const host = { reads: [] as string[], listings: 0 };
  const ports = {
    ...vault.ports,
    fs: {
      ...vault.ports.fs,
      listDirectory: async (path: VaultPath) => {
        host.listings += 1;
        return vault.ports.fs.listDirectory(path);
      },
      readTextFile: async (path: VaultPath) => {
        host.reads.push(path);
        return vault.ports.fs.readTextFile(path);
      },
    },
  };
  const activity = recordingActivity();
  const state = {
    named,
    gate: { open: true, standing: PULL } as WaitingCountGate,
    ledger: LEDGER,
    failing: null as string | null,
    gateCalls: 0,
    /** What the index says the rules take; undefined leaves the watch without it. */
    taken: undefined as PostProcessingLedger['taken'] | null | undefined,
    takeAsked: [] as { paths: readonly string[]; generation: number }[],
  };
  const said: (MeetingsWaiting | null)[] = [];
  const watch: MeetingsWaitingWatch = {
    namedElsewhere: () => state.named,
    countGate: async () => {
      state.gateCalls += 1;
      return state.gate;
    },
    said: (_, waiting) => void said.push(waiting),
    postProcessing: () => state.ledger,
    stepFailing: () => (state.failing === null ? null : { problem: state.failing, mac: 'Studio' }),
    rulesTake: async (_, asked) => {
      state.takeAsked.push(asked);
      return state.taken;
    },
  };
  const importer = createMeetingImporter({
    ports: () => ports,
    clock: { today: () => TODAY },
    activity,
    openVault: () => VAULT,
    active: () => importing,
    onWritten: vi.fn(),
    waiting: watch,
  });
  const warnings = () =>
    activity.reports.filter((report) => report.level === 'warning').map((report) => report.message);
  return { importer, state, said, warnings, host, markdown: vault.ports.markdown };
}

describe('the waiting count with post-processing pending, on a Mac that is not named (#182)', () => {
  it('sums the meetings not imported and the imported ones whose summary and tasks are pending', async () => {
    const { importer, warnings } = setUp();

    const outcome = await importer.catchUp(VAULT);

    expect(outcome?.waiting).toEqual({ kind: 'counted', mac: 'Studio', count: 2 });
    expect(warnings()).toEqual(['2 meetings are waiting for Studio to process them.']);
  });

  it('counts the unimported alone while no rule writes summaries', async () => {
    const { importer, state } = setUp();
    state.ledger = NO_POST_PROCESSING;

    expect((await importer.catchUp(VAULT))?.waiting).toEqual({
      kind: 'counted',
      mac: 'Studio',
      count: 1,
    });
  });

  it('clears a pending meeting once a retry answers it, reading no file again', async () => {
    const { importer, state, host } = setUp();
    await importer.catchUp(VAULT);
    const reads = host.reads.length;

    state.ledger = { ...LEDGER, answered: new Set([ANSWERED, PENDING]) };
    const outcome = await importer.recount(VAULT);

    expect(outcome?.waiting).toEqual({ kind: 'counted', mac: 'Studio', count: 1 });
    expect(host.reads.length).toBe(reads);
  });

  it('counts an answered meeting again while an answer stored for its words waits to be written', async () => {
    const { importer, state, markdown } = setUp();
    await importer.catchUp(VAULT);
    const text = NOTES[ANSWERED]!;
    const properties = markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
    const key = postProcessingKeyOf({ text, properties });
    expect(key).toMatch(/^meeting:gemini:gemini-answered:transcript:/);
    state.ledger = { ...LEDGER, stored: new Set([key!]) };

    expect((await importer.recount(VAULT))?.waiting).toMatchObject({ count: 3 });
  });
});

describe('the Mac that runs the automations, when its step cannot reach Claude (#182)', () => {
  it('healthy: says nothing, and asks the host nothing', async () => {
    const { importer, said, host, warnings, state } = setUp({ named: null, importing: true });
    const listings = host.listings;
    const reads = host.reads.length;

    await importer.recount(VAULT);

    expect(said).toEqual([null]);
    expect({ listings: host.listings - listings, reads: host.reads.length - reads }).toEqual({
      listings: 0,
      reads: 0,
    });
    expect(state.gateCalls).toBe(0);
    expect(warnings()).toEqual([]);
  });

  it('failing: shows the line with the pending count, and warns once however often it fails again', async () => {
    const { importer, state, warnings } = setUp({ named: null, importing: true });
    state.failing = NOT_LOGGED_IN;

    const first = await importer.recount(VAULT);
    await importer.recount(VAULT);
    await importer.catchUp(VAULT);

    expect(first?.waiting).toEqual({
      kind: 'failing',
      mac: 'Studio',
      count: 1,
      problem: NOT_LOGGED_IN,
    });
    expect(warnings()).toEqual([
      `Claude is unavailable on Studio: summaries and tasks are pending. ${NOT_LOGGED_IN}`,
    ]);
  });

  it('says it again for a failure that cleared and came back', async () => {
    const { importer, state, warnings } = setUp({ named: null, importing: true });
    state.failing = NOT_LOGGED_IN;
    await importer.recount(VAULT);
    state.failing = null;
    expect((await importer.recount(VAULT))?.waiting).toBeUndefined();
    state.failing = NOT_LOGGED_IN;
    await importer.recount(VAULT);

    expect(warnings()).toHaveLength(2);
  });

  it('gives no count before the gates hold, and reads no meeting for it', async () => {
    const { importer, state, host } = setUp({ named: null, importing: true });
    state.failing = NOT_LOGGED_IN;
    state.gate = { open: false, why: 'no-pull' };

    const outcome = await importer.recount(VAULT);

    expect(outcome?.waiting).toMatchObject({ kind: 'failing', count: null });
    expect(host.reads).toEqual([]);
  });

  it('keeps the count it said while a pull is under way', async () => {
    const { importer, state } = setUp({ named: null, importing: true });
    state.failing = NOT_LOGGED_IN;
    await importer.recount(VAULT);
    state.gate = { open: false, why: 'pulling' };

    expect((await importer.recount(VAULT))?.waiting).toMatchObject({ count: 1 });
  });

  it('reads again only the meeting news names, once its step writes it', async () => {
    const { importer, state, host } = setUp({ named: null, importing: true });
    state.failing = NOT_LOGGED_IN;
    await importer.recount(VAULT);
    const reads = host.reads.length;

    await importer.hear({
      vault: VAULT,
      changes: [{ kind: 'changed', path: createVaultPath(PENDING), type: 'meeting', digest: 'x' }],
    });

    expect(host.reads.slice(reads)).not.toContain(ANSWERED);
    expect(host.reads.slice(reads)).toContain(PENDING);
  });

  it('asks the gate nothing for news of a note that is no meeting, saying what it said (#637 review)', async () => {
    const { importer, state, said } = setUp({ named: null, importing: true });
    state.failing = NOT_LOGGED_IN;
    await importer.recount(VAULT);
    const calls = state.gateCalls;

    const outcome = await importer.hear({
      vault: VAULT,
      changes: [
        { kind: 'changed', path: createVaultPath('Inbox/Call Mara.md'), type: 'task', digest: 'y' },
      ],
    });

    expect(state.gateCalls).toBe(calls);
    expect(outcome?.waiting).toEqual(said.at(-1));
    expect(outcome?.waiting).toMatchObject({ kind: 'failing', count: 1 });
  });

  it('judges again for news of a meeting, or when the failure changes', async () => {
    const { importer, state } = setUp({ named: null, importing: true });
    state.failing = NOT_LOGGED_IN;
    await importer.recount(VAULT);
    const calls = state.gateCalls;

    await importer.hear({
      vault: VAULT,
      changes: [{ kind: 'changed', path: createVaultPath(PENDING), type: 'meeting', digest: 'z' }],
    });
    expect(state.gateCalls).toBeGreaterThan(calls);

    const after = state.gateCalls;
    state.failing = 'Claude Code is not installed on this Mac.';
    await importer.hear({
      vault: VAULT,
      changes: [
        { kind: 'changed', path: createVaultPath('Inbox/Call Mara.md'), type: 'task', digest: 'w' },
      ],
    });
    expect(state.gateCalls).toBeGreaterThan(after);
  });
});

describe('the healthy Mac that runs the automations, at each index sync (attack on PR #637)', () => {
  it('asks the gate nothing and reads nothing for news of meetings and other notes alike', async () => {
    const { importer, state, host, said } = setUp({ named: null, importing: true });
    await importer.catchUp(VAULT);
    const calls = state.gateCalls;
    const reads = host.reads.length;
    const listings = host.listings;

    for (const [path, type] of [
      ['Inbox/Call Mara.md', 'task'],
      ['Inbox/Call Mara.md', 'task'],
      [PENDING, 'meeting'],
    ] as const) {
      await importer.hear({
        vault: VAULT,
        changes: [{ kind: 'changed', path: createVaultPath(path), type, digest: path }],
      });
    }

    expect(state.gateCalls - calls).toBe(0);
    expect(host.reads.slice(reads).filter((read) => read !== PENDING)).toEqual([]);
    expect(host.listings - listings).toBe(0);
    expect(said.at(-1)).toBeNull();
  });
});

describe('the count with what the index says the rules take (#637 attack)', () => {
  it('counts a pending meeting only if the rules’ own queries take it', async () => {
    const { importer, state } = setUp();
    state.taken = { paths: new Set(), from: '2026-09-24' };

    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({ count: 1 });
    // Only the imported meetings that could be pending, answered or not, are asked about: never the unimported.
    expect(state.takeAsked.map(({ paths }) => [...paths].sort())).toEqual([[ANSWERED, PENDING]]);

    state.taken = { paths: new Set([PENDING]), from: '2026-09-24' };
    expect((await importer.recount(VAULT))?.waiting).toMatchObject({ count: 2 });
  });

  it('judges by the ledger alone when the index cannot say', async () => {
    const { importer, state } = setUp();
    state.taken = null;

    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({ count: 2 });
  });

  it('moves the generation it asks with only when a meeting file changed', async () => {
    const { importer, state } = setUp();
    state.taken = { paths: new Set([PENDING]), from: '2026-09-24' };
    await importer.catchUp(VAULT);
    await importer.recount(VAULT);
    await importer.hear({
      vault: VAULT,
      changes: [
        { kind: 'changed', path: createVaultPath('Inbox/Call Mara.md'), type: 'task', digest: 'a' },
      ],
    });
    await importer.hear({
      vault: VAULT,
      changes: [{ kind: 'changed', path: createVaultPath(PENDING), type: 'meeting', digest: 'b' }],
    });

    const [first, second, third] = state.takeAsked.map(({ generation }) => generation);
    expect(second).toBe(first);
    expect(third).toBeGreaterThan(first!);
    expect(state.takeAsked).toHaveLength(3);
  });

  it('asks the index nothing on a healthy named Mac, nor while no rule writes summaries', async () => {
    const named = setUp({ named: null, importing: true });
    named.state.taken = { paths: new Set(), from: '2026-09-24' };
    await named.importer.catchUp(VAULT);
    await named.importer.recount(VAULT);
    expect(named.state.takeAsked).toEqual([]);

    const other = setUp();
    other.state.ledger = NO_POST_PROCESSING;
    await other.importer.catchUp(VAULT);
    expect(other.state.takeAsked).toEqual([]);
  });
});
