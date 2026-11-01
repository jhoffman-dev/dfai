// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  appendLogEntry,
  createVaultPath,
  digestOf,
  logPathFor,
  movedPath,
  parseRunLog,
  type EntryMove,
  type PullStanding,
  type VaultEntry,
  type VaultPath,
  WEB_CAPABILITIES,
} from '@dfai/domain';
import {
  NEEDS_THE_DESKTOP_APP,
  entryPointsOffered,
  EVERY_ENTRY_POINT,
  fakeClaudeStepPorts,
  fakeIndexPort,
  fakeVaultFs,
  ModelProviderError,
  recordingActivity,
  type AutomationPorts,
  type EntryPointsOffered,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import {
  HELD_NEWS,
  queueByRule,
  SCHEDULE_TICK_MS,
  useAutomations,
  type AutomationsOptions,
} from './use-automations.ts';

/**
 * A rule a note sets off, and a meeting the import let in just before DFAI
 * was quit (ADR-0028, "Catching up when DFAI opens"): the feed has nothing
 * to say of it on opening, so the rule is run on it once, from what the
 * files and its log say. An archive rule stands in for a Claude step.
 */

const VAULT = '/vaults/home';
const RULE = '.atlas/automations/Sweep.md';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
const OLDER = 'Inbox/Meetings/2026-10-01 Kickoff.md';

const RULE_TEXT = [
  '---',
  'atlas: automation',
  'name: Sweep',
  'enabled: true',
  'when: a meeting is created',
  'which: FROM meeting',
  'do: archive',
  '---',
  '',
].join('\n');
const LET_IN = '---\ntype: meeting\natlas_import_outcome: imported\n---\n';

/** A vault in memory: each file with the time it was last written, and an index that has read them all. */
function memoryVault(files: Record<string, string>, modified: Record<string, number>) {
  const dirs = new Set(['.atlas', '.atlas/automations', 'Inbox', 'Inbox/Meetings']);
  const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const entry = (path: string, kind: VaultEntry['kind']) =>
    ({
      kind,
      name: path.slice(path.lastIndexOf('/') + 1),
      path: createVaultPath(path),
    }) as VaultEntry;
  const fs = fakeVaultFs({
    listNotes: async () =>
      Object.keys(files).map((path) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        path: createVaultPath(path),
        modified: modified[path] ?? 1,
        size: 1,
      })),
    listDirectory: async (at) => [
      ...[...dirs].filter((dir) => parent(dir) === at).map((dir) => entry(dir, 'directory')),
      ...Object.keys(files)
        .filter((file) => parent(file) === at)
        .map((file) => entry(file, 'file')),
    ],
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = files[path];
        return text === undefined
          ? []
          : [{ path, text, modified: modified[path] ?? 1, size: text.length }];
      }),
    readTextFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error('no such note');
      return { text, modified: modified[path] ?? 1 };
    },
    createFolder: async ({ path }) => void dirs.add(path),
    createNote: async ({ path, contents }) => {
      files[path] = contents;
      return 0;
    },
    writeTextFile: async ({ path, contents }) => {
      files[path] = contents;
      return 1;
    },
    moveEntry: async (move: EntryMove) => {
      for (const path of Object.keys(files)) {
        const to = movedPath(path as VaultPath, move);
        if (to === null) continue;
        files[to] = files[path]!;
        delete files[path];
      }
    },
  });
  const meetings = () => Object.keys(files).filter((path) => path.startsWith('Inbox/Meetings/'));
  const index = fakeIndexPort({
    manifest: async () =>
      meetings().map((path) => ({
        path,
        type: 'meeting',
        digest: digestOf(files[path] ?? ''),
        modified: modified[path] ?? 1,
        size: 1,
      })),
    query: async (sql, parameters) =>
      sql.startsWith('/* meetings */')
        ? // The import's stamps, as the index holds them.
          {
            columns: ['path', 'value_text'],
            rows: meetings().map((path) => [path, 'imported']),
            truncated: false,
          }
        : {
            columns: ['path', 'title', 'type'],
            rows: meetings()
              .filter((path) => parameters.includes(path))
              .map((path) => [path, path, 'meeting']),
            truncated: false,
          },
  });
  const ports: AutomationPorts & { notePaths: readonly VaultPath[] } = {
    fs,
    markdown: remarkMarkdown,
    index,
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
    types: [{ name: 'meeting', label: 'Meeting', properties: [] } as never],
    get notePaths() {
      return Object.keys(files).map(createVaultPath);
    },
    claude: fakeClaudeStepPorts(),
  };
  return { files, ports };
}

const clock = {
  today: () => '2026-10-08',
  localNow: () => '2026-10-08T09:00:00',
  now: () => Date.parse('2026-10-08T09:00:00Z'),
};

async function settle() {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutomations: opening a vault whose rule missed a meeting’s arrival', () => {
  const open = (scheduled?: boolean) => {
    // The rule was saved at 100; one meeting was let in before that, one after.
    const vault = memoryVault(
      { [RULE]: RULE_TEXT, [OLDER]: LET_IN, [MEETING]: LET_IN },
      { [RULE]: 100, [OLDER]: 50, [MEETING]: 200 },
    );
    const activity = recordingActivity();
    const options: AutomationsOptions = {
      offered: EVERY_ENTRY_POINT,
      ports: vault.ports,
      clock,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity,
      onSettled: vi.fn(),
      ...(scheduled !== undefined && { scheduled }),
    };
    renderHook((props: AutomationsOptions) => useAutomations(props), { initialProps: options });
    return { vault, activity };
  };

  it('runs the rule once on the meeting let in since the rule was saved, and on no older one', async () => {
    const { vault, activity } = open();
    await settle();

    expect(vault.files[MEETING]).toBeUndefined();
    expect(Object.keys(vault.files)).toContain(`Archive/${MEETING}`);
    expect(vault.files[OLDER]).toBe(LET_IN);
    expect(activity.reports.map((report) => report.message)).toEqual([
      'Sweep: Ran when a note appeared or changed (2026-10-06 Standup). Archived 1 note.',
    ]);
  });

  it('does not on a Mac that does not run the vault’s automations', async () => {
    const { vault } = open(false);
    await settle();

    expect(vault.files[MEETING]).toBe(LET_IN);
  });
});

describe('useAutomations: the catch-up again once this Mac is named (ADR-0035, #176)', () => {
  const LATER = 'Inbox/Meetings/2026-10-07 Vendor call.md';
  const open = (scheduled: boolean) => {
    const modified: Record<string, number> = { [RULE]: 100, [MEETING]: 200 };
    const vault = memoryVault({ [RULE]: RULE_TEXT, [MEETING]: LET_IN }, modified);
    const activity = recordingActivity();
    const options: AutomationsOptions = {
      offered: EVERY_ENTRY_POINT,
      ports: vault.ports,
      clock,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity,
      onSettled: vi.fn(),
      scheduled,
    };
    const hook = renderHook((props: AutomationsOptions) => useAutomations(props), {
      initialProps: options,
    });
    /** A meeting let in with no news of it reaching this Mac's rules: only a catch-up finds it. */
    const letInQuietly = () => {
      vault.files[LATER] = LET_IN;
      modified[LATER] = 300;
    };
    const draw = (next: Partial<AutomationsOptions>) =>
      hook.rerender({ ...options, ports: vault.ports, ...next });
    return { vault, activity, letInQuietly, draw };
  };
  const ran = (activity: ReturnType<typeof recordingActivity>) =>
    activity.reports.filter((report) => report.message.startsWith('Sweep: Ran')).length;

  it('catches up when the Mac becomes the named one, false to true', async () => {
    const { vault, activity, draw } = open(false);
    await settle();
    expect(vault.files[MEETING]).toBe(LET_IN);

    draw({ scheduled: true });
    await settle();

    expect(vault.files[MEETING]).toBeUndefined();
    expect(Object.keys(vault.files)).toContain(`Archive/${MEETING}`);
    expect(ran(activity)).toBe(1);
  });

  it('catches up again after a spell as another Mac’s, so a claim behaves as a move in Settings → Sync', async () => {
    const { vault, activity, letInQuietly, draw } = open(true);
    await settle();
    expect(ran(activity)).toBe(1);

    draw({ scheduled: false });
    await settle();
    letInQuietly();
    draw({ scheduled: true });
    await settle();

    expect(vault.files[LATER]).toBeUndefined();
    expect(Object.keys(vault.files)).toContain(`Archive/${LATER}`);
    expect(ran(activity)).toBe(2);
  });

  it('does not catch up again while it stays named, true to true', async () => {
    const { vault, activity, letInQuietly, draw } = open(true);
    await settle();
    letInQuietly();

    draw({ scheduled: true, indexKey: '2' });
    await settle();

    expect(vault.files[LATER]).toBe(LET_IN);
    expect(ran(activity)).toBe(1);
  });
});

describe('useAutomations: a Claude step waits for fresh sync state (ADR-0035 part 4)', () => {
  const ASK_RULE = '.atlas/automations/Actions.md';
  const ASK_RULE_TEXT = [
    '---',
    'atlas: automation',
    'name: Actions',
    'enabled: true',
    'when: a meeting is created',
    'which: FROM meeting',
    'do: claude',
    'prompt: .atlas/prompts/actions.md',
    'output: proposals',
    '---',
    '',
  ].join('\n');
  const PULLED: PullStanding = {
    kind: 'pulled',
    startedAsleepMs: 0,
    finishedAt: 1,
    namedAfter: true,
  };

  const open = (
    rule: { path: string; text: string },
    pulledFiles: Gate,
    offered: EntryPointsOffered = EVERY_ENTRY_POINT,
  ) => {
    const vault = memoryVault(
      {
        [rule.path]: rule.text,
        '.atlas/prompts/actions.md': 'List the action items.\n',
        [MEETING]: LET_IN,
      },
      { [rule.path]: 100, [MEETING]: 200 },
    );
    const claude = fakeClaudeStepPorts();
    const options: AutomationsOptions = {
      offered,
      ports: { ...vault.ports, claude },
      clock,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity: recordingActivity(),
      onSettled: vi.fn(),
      scheduled: true,
      pulledFiles,
    };
    const hook = renderHook((props: AutomationsOptions) => useAutomations(props), {
      initialProps: options,
    });
    return { vault, claude, hook, options };
  };

  type Gate = NonNullable<AutomationsOptions['pulledFiles']>;

  it('holds its look for missed arrivals until a pull completes, then asks once', async () => {
    const shut = vi.fn(async () => false);
    const { claude, hook, options } = open(
      { path: ASK_RULE, text: ASK_RULE_TEXT },
      { standing: null, acts: shut },
    );
    await settle();
    expect(shut).toHaveBeenCalledWith(VAULT);
    expect(claude.fake.requests).toHaveLength(0);

    hook.rerender({ ...options, pulledFiles: { standing: PULLED, acts: async () => true } });
    await settle();
    expect(claude.fake.requests).toHaveLength(1);
  });

  it('asks no Claude where there is none, and says the rule needs the desktop app (#657)', async () => {
    const { claude, hook, vault } = open(
      { path: ASK_RULE, text: ASK_RULE_TEXT },
      { standing: PULLED, acts: async () => true },
      entryPointsOffered(WEB_CAPABILITIES),
    );
    await settle();
    expect(claude.fake.requests).toHaveLength(0);
    const rule = hook.result.current.listing?.automations[0]?.rule;
    expect(rule).toBeDefined();
    expect(hook.result.current.pauses.get(rule!.id)).toEqual({
      reason: NEEDS_THE_DESKTOP_APP,
      failures: 0,
      retryAt: null,
    });
    // Nothing was written for it: no log entry saying it failed.
    expect(Object.keys(vault.files).filter((path) => path.includes('/log/'))).toEqual([]);
    // Nor is it tried again as the minutes pass.
    await act(async () => vi.advanceTimersByTimeAsync(5 * SCHEDULE_TICK_MS));
    await settle();
    expect(claude.fake.requests).toHaveLength(0);
  });

  it('asks the gate again when its turn comes: shut by then, the news waits for a pull', async () => {
    // Open as it is queued, shut by the time it runs: the Mac slept in between.
    const acts = vi.fn(async () => false).mockResolvedValueOnce(true);
    const { claude, hook, options } = open(
      { path: ASK_RULE, text: ASK_RULE_TEXT },
      { standing: PULLED, acts },
    );
    await settle();
    expect(acts.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(claude.fake.requests).toHaveLength(0);

    acts.mockImplementation(async () => true);
    hook.rerender({ ...options, pulledFiles: { standing: { ...PULLED, finishedAt: 2 }, acts } });
    await settle();
    expect(claude.fake.requests).toHaveLength(1);
  });

  it('in a syncing vault, once claimed, holds the catch-up while the last pull named the other Mac, then asks once after the claim’s sync (#630 review)', async () => {
    const before: PullStanding = { ...PULLED, namedAfter: false };
    // The real gate's rule in short: open only on a pull whose settings named this Mac.
    const gateAt = (standing: PullStanding): Gate => ({
      standing,
      acts: async () => standing.kind === 'pulled' && standing.namedAfter,
    });
    const { claude, hook, options } = open({ path: ASK_RULE, text: ASK_RULE_TEXT }, gateAt(before));
    // Named once in this session, then another Mac took the automations.
    await settle();
    hook.rerender({ ...options, scheduled: false });
    await settle();

    // "Process here" names this Mac; the last pull still named the other.
    hook.rerender({ ...options, scheduled: true, pulledFiles: gateAt(before) });
    await settle();
    expect(claude.fake.requests).toHaveLength(0);

    // The claim's sync completes, its settings naming this Mac.
    const after: PullStanding = { ...PULLED, finishedAt: 2, namedAfter: true };
    hook.rerender({ ...options, scheduled: true, pulledFiles: gateAt(after) });
    await settle();
    expect(claude.fake.requests).toHaveLength(1);

    // Drawn again on the same pull, and on the next: asked no more.
    hook.rerender({ ...options, scheduled: true, pulledFiles: gateAt(after) });
    await settle();
    hook.rerender({
      ...options,
      scheduled: true,
      pulledFiles: gateAt({ ...PULLED, finishedAt: 3, namedAfter: true }),
    });
    await settle();
    expect(claude.fake.requests).toHaveLength(1);
  });

  it('does not hold a rule that asks no Claude', async () => {
    const shut = vi.fn(async () => false);
    const { vault } = open({ path: RULE, text: RULE_TEXT }, { standing: null, acts: shut });
    await settle();
    expect(Object.keys(vault.files)).toContain(`Archive/${MEETING}`);
    expect(shut).not.toHaveBeenCalled();
  });
});

describe('useAutomations: opening a vault whose rule handled more meetings than its log keeps', () => {
  it('asks about none of the 150 it handled, though the log holds the last 100 entries', async () => {
    const handled = Array.from({ length: 150 }, (_, at) => `Inbox/Meetings/Standup ${at}.md`);
    const log = handled.reduce<string | null>(
      (text, path, at) =>
        appendLogEntry({
          text,
          ruleName: 'Sweep',
          now: Date.parse('2026-10-08T09:00:00Z'),
          entry: {
            kind: 'run',
            at: `2026-10-0${1 + (at % 7)}T09:00:00`,
            trigger: 'note',
            done: [],
            left: [],
            capped: false,
            versions: [{ path: createVaultPath(path), digest: digestOf(LET_IN), wrote: false }],
          },
        }),
      null,
    )!;
    const vault = memoryVault(
      {
        [RULE]: RULE_TEXT,
        [logPathFor('Sweep')]: log,
        ...Object.fromEntries(handled.map((path) => [path, LET_IN])),
      },
      { [RULE]: 100, ...Object.fromEntries(handled.map((path) => [path, 200])) },
    );
    const activity = recordingActivity();
    renderHook((props: AutomationsOptions) => useAutomations(props), {
      initialProps: {
        offered: EVERY_ENTRY_POINT,
        ports: vault.ports,
        clock,
        vaultKey: VAULT,
        indexKey: '1',
        indexReady: true,
        activity,
        onSettled: vi.fn(),
      },
    });
    await settle();

    expect(Object.keys(vault.files).filter((path) => path.startsWith('Archive/'))).toEqual([]);
    expect(activity.reports).toEqual([]);
  });
});

describe('queueByRule: the look for missed arrivals', () => {
  const rule = {
    id: 'Sweep',
    enabled: true,
    when: { kind: 'note', type: 'meeting', on: ['created'] },
  } as never;
  const listing = { automations: [{ rule }], broken: [] } as never;
  const news = (at: number) => ({
    vault: VAULT,
    changes: [
      { kind: 'added' as const, path: `Meetings/${at}.md`, type: 'meeting', digest: `d${at}` },
    ],
  });

  it('survives more news than a queue holds, and the oldest news is what goes', () => {
    const marker = { vault: VAULT, missedArrivals: true as const };
    const queues = new Map([['Sweep', [marker]]]);
    const all = Array.from({ length: HELD_NEWS + 5 }, (_, at) => news(at));

    const letGo = queueByRule(queues, listing, all);

    const held = queues.get('Sweep')!;
    expect(held[0]).toBe(marker);
    expect(held).toHaveLength(HELD_NEWS + 1);
    expect(held.slice(1)).toEqual(all.slice(-HELD_NEWS));
    expect(letGo.get('Sweep')).toBe(5);
  });
});

describe('adversarial #174: a Claude step the Mac slept through', () => {
  /**
   * The gate is asked before the Claude step starts, never after. A model
   * turn takes minutes; if the lid closes during it, the Mac wakes and
   * writes what Claude said — the rule's log, its proposals — before any
   * pull, though another Mac may have claimed the automations and run the
   * same rule meanwhile (ADR-0035 part 4, H7: "A must run nothing until it
   * pulls"). The rule's log is a synced note written for one writer.
   */
  it('writes nothing once the Mac has slept during the model turn, until a pull after the wake', async () => {
    const ASK_RULE = '.atlas/automations/Actions.md';
    const ASK_RULE_TEXT = [
      '---',
      'atlas: automation',
      'name: Actions',
      'enabled: true',
      'when: a meeting is created',
      'which: FROM meeting',
      'do: claude',
      'prompt: .atlas/prompts/actions.md',
      'output: proposals',
      '---',
      '',
    ].join('\n');
    let awake = true;
    let atSleep: Record<string, string> | null = null;
    const vault = memoryVault(
      {
        [ASK_RULE]: ASK_RULE_TEXT,
        '.atlas/prompts/actions.md': 'List the action items.\n',
        [MEETING]: LET_IN,
      },
      { [ASK_RULE]: 100, [MEETING]: 200 },
    );
    const claude = fakeClaudeStepPorts({
      rounds: [
        async function* () {
          // The lid closes while Claude is answering.
          awake = false;
          atSleep = { ...vault.files };
          yield { type: 'text' as const, text: JSON.stringify({ proposals: [] }) };
        },
      ],
    });
    const PULLED: PullStanding = {
      kind: 'pulled',
      startedAsleepMs: 0,
      finishedAt: 1,
      namedAfter: true,
    };
    const options: AutomationsOptions = {
      offered: EVERY_ENTRY_POINT,
      ports: { ...vault.ports, claude },
      clock,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity: recordingActivity(),
      onSettled: vi.fn(),
      scheduled: true,
      pulledFiles: { standing: PULLED, acts: async () => awake },
    };
    renderHook((props: AutomationsOptions) => useAutomations(props), { initialProps: options });
    await settle();

    expect(claude.fake.requests).toHaveLength(1);
    expect(atSleep).not.toBeNull();
    expect(vault.files).toEqual(atSleep);
  });
});

describe('useAutomations: a Claude step the clock or opening sets off waits for fresh sync state (#174)', () => {
  const ASK = '.atlas/automations/Brief.md';
  const askText = (when: string) =>
    [
      '---',
      'atlas: automation',
      'name: Brief',
      'enabled: true',
      `when: ${when}`,
      'which: FROM meeting',
      'do: claude',
      'prompt: .atlas/prompts/actions.md',
      'output: proposals',
      '---',
      '',
    ].join('\n');
  /** The rule ran on its schedule yesterday, so today's 08:00 is due at 09:00. */
  const ranYesterday = appendLogEntry({
    text: null,
    ruleName: 'Brief',
    now: Date.parse('2026-10-07T08:00:00Z'),
    entry: {
      kind: 'run',
      at: '2026-10-07T08:00:00',
      trigger: 'schedule',
      done: [],
      left: [],
      capped: false,
    },
  });
  const PULLED: PullStanding = {
    kind: 'pulled',
    startedAsleepMs: 0,
    finishedAt: 1,
    namedAfter: true,
  };

  const open = (when: string, extra: Record<string, string> = {}) => {
    const vault = memoryVault(
      {
        [ASK]: askText(when),
        '.atlas/prompts/actions.md': 'List the action items.\n',
        [MEETING]: LET_IN,
        ...extra,
      },
      { [ASK]: 100, [MEETING]: 200 },
    );
    const gate = { open: false };
    // One answer, and a sound one: a second run would find no answer left, and a failed one would pause the rule.
    const claude = fakeClaudeStepPorts({
      rounds: [[{ type: 'text', text: JSON.stringify({ proposals: [] }) }]],
    });
    // The rule's query, run by the clock or by hand, finds the one meeting.
    const index = {
      ...vault.ports.index,
      query: async (sql: string, parameters: readonly (string | number | null)[]) =>
        sql.startsWith('/* meetings */')
          ? vault.ports.index.query(sql, parameters)
          : {
              columns: ['path', 'title', 'type'],
              rows: [[MEETING, MEETING, 'meeting']],
              truncated: false,
            },
    };
    const options: AutomationsOptions = {
      offered: EVERY_ENTRY_POINT,
      ports: { ...vault.ports, index, claude },
      clock,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity: recordingActivity(),
      onSettled: vi.fn(),
      scheduled: true,
      pulledFiles: { standing: null, acts: async () => gate.open },
    };
    const hook = renderHook((props: AutomationsOptions) => useAutomations(props), {
      initialProps: options,
    });
    /** A pull completes, and the gates open. */
    const pullCompletes = async (finishedAt: number) => {
      gate.open = true;
      hook.rerender({
        ...options,
        pulledFiles: { standing: { ...PULLED, finishedAt }, acts: async () => gate.open },
      });
      await settle();
    };
    return { claude, hook, pullCompletes, gate, vault, options };
  };

  it('holds a rule that runs on opening while the gates are shut, and runs it once a pull completes', async () => {
    const { claude, pullCompletes, vault } = open('on app open');
    await settle();
    expect(claude.fake.requests).toHaveLength(0);

    await pullCompletes(2);
    expect(claude.fake.requests).toHaveLength(1);
    // Run once: the next pull does not run it again.
    await pullCompletes(3);
    expect(claude.fake.requests).toHaveLength(1);
    // Its log holds the one run on opening.
    const runs = parseRunLog(vault.files[logPathFor('Brief')] ?? '');
    expect(runs.filter((entry) => 'trigger' in entry && entry.trigger === 'open')).toHaveLength(1);
  });

  it('does not so much as start a held rule while the gates stay shut, minute after minute', async () => {
    const { claude, options, vault } = open('daily at 08:00', {
      [logPathFor('Brief')]: ranYesterday,
    });
    await settle();
    const settled = vi.mocked(options.onSettled).mock.calls.length;
    const listed = vi.spyOn(vault.ports.fs, 'listNotes');

    for (let minute = 0; minute < 3; minute += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
      });
      await settle();
    }

    expect(claude.fake.requests).toHaveLength(0);
    expect(listed).not.toHaveBeenCalled();
    expect(vi.mocked(options.onSettled).mock.calls.length).toBe(settled);
  });

  it('holds a schedule that comes due while the gates are shut, and runs it at the next pull', async () => {
    const { claude, pullCompletes } = open('daily at 08:00', {
      [logPathFor('Brief')]: ranYesterday,
    });
    await settle();
    expect(claude.fake.requests).toHaveLength(0);

    await pullCompletes(2);
    expect(claude.fake.requests).toHaveLength(1);
  });

  it('runs it by hand whatever the gates say: the person started it', async () => {
    const { claude, hook } = open('manually');
    await settle();
    await act(async () => {
      const ran = hook.result.current.listing!.automations[0]!.rule;
      await hook.result.current.runNow(ran);
    });
    expect(claude.fake.requests).toHaveLength(1);
  });
});

describe('useAutomations: a Claude step that cannot reach Claude backs off and is tried again (#182)', () => {
  const ASK_RULE = '.atlas/automations/Actions.md';
  const ASK_RULE_TEXT = [
    '---',
    'atlas: automation',
    'name: Actions',
    'enabled: true',
    'when: a meeting is created',
    'which: FROM meeting',
    'do: claude',
    'prompt: .atlas/prompts/actions.md',
    'output: proposals',
    '---',
    '',
  ].join('\n');
  const NOT_LOGGED_IN = {
    ready: false as const,
    problem: 'not_logged_in' as const,
    message: 'Claude Code is installed but not logged in.',
    fix: 'claude auth login',
  };

  /** The vault with one meeting the rule missed, Claude logged out, and a clock the test moves. */
  const openLoggedOut = (scheduled: boolean | null = true) => {
    const at = { now: '2026-10-08T09:00:00' };
    const ticking = {
      today: () => at.now.slice(0, 10),
      localNow: () => at.now,
      now: () => Date.parse(`${at.now}Z`),
    };
    const vault = memoryVault(
      {
        [ASK_RULE]: ASK_RULE_TEXT,
        '.atlas/prompts/actions.md': 'List the action items.\n',
        [MEETING]: LET_IN,
      },
      { [ASK_RULE]: 100, [MEETING]: 200 },
    );
    const claude = fakeClaudeStepPorts({
      status: NOT_LOGGED_IN,
      rounds: [[{ type: 'text', text: JSON.stringify({ proposals: [] }) }]],
    });
    const statusAsked = { count: 0 };
    const provider = claude.provider();
    const notReady = provider.status;
    provider.status = async () => {
      statusAsked.count += 1;
      return notReady();
    };
    // Its query, run by hand, finds the meeting as the index would, whatever it is handed.
    const index = {
      ...vault.ports.index,
      query: async (sql: string, parameters: readonly (string | number | null)[]) =>
        sql.startsWith('/* meetings */')
          ? vault.ports.index.query(sql, parameters)
          : {
              columns: ['path', 'title', 'type'],
              rows: [[MEETING, MEETING, 'meeting']],
              truncated: false,
            },
    };
    const options: AutomationsOptions = {
      offered: EVERY_ENTRY_POINT,
      ports: { ...vault.ports, index, claude },
      clock: ticking,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity: recordingActivity(),
      onSettled: vi.fn(),
      scheduled,
    };
    const hook = renderHook((props: AutomationsOptions) => useAutomations(props), {
      initialProps: options,
    });
    /** Logged in; the status takes a second to answer, as a process the host starts does. */
    const logIn = () => {
      provider.status = () => {
        statusAsked.count += 1;
        return new Promise((resolve) => setTimeout(() => resolve({ ready: true }), 1000));
      };
    };
    return { at, claude, hook, options, logIn, statusAsked };
  };

  it('once Claude is logged in, runs at the next tick, long before the pause would end (#637 review)', async () => {
    const { claude, hook, logIn } = openLoggedOut();
    await settle();
    expect([...hook.result.current.pauses.values()][0]?.unavailable).toBeDefined();

    // Still 09:00, the pause says 09:01: only the status, asked at each tick, can let it go.
    logIn();
    // One tick, and the second its answer takes: well before the next tick, the run is made.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    });
    // The recheck's answer, then the run's own look at the status.
    for (let answer = 0; answer < 2; answer += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await settle();

    expect(hook.result.current.pauses.size).toBe(0);
    expect(claude.fake.requests).toHaveLength(1);
  });

  it('keeps the pause, and why, when Run now fails the same way (#637 review)', async () => {
    const { hook, statusAsked } = openLoggedOut();
    await settle();
    const rule = hook.result.current.listing!.automations[0]!.rule;
    const before = { ...[...hook.result.current.pauses.values()][0] };
    const asks = statusAsked.count;

    let entry: unknown = null;
    await act(async () => {
      entry = await hook.result.current.runNow(rule);
    });
    await settle();

    expect(entry).toMatchObject({ kind: 'failed' });
    // The pause stands as it was: the held news is not let go to fail again at once.
    expect([...hook.result.current.pauses.values()][0]).toEqual(before);
    expect(statusAsked.count - asks).toBe(1);
  });

  it('lets go of a pause for Claude once this Mac no longer runs the automations (#637 review)', async () => {
    const { hook, options } = openLoggedOut();
    await settle();
    expect(hook.result.current.pauses.size).toBe(1);

    hook.rerender({ ...options, scheduled: false });
    await settle();

    expect([...hook.result.current.pauses.values()].some((pause) => pause.unavailable)).toBe(false);
  });

  it('pauses with the fix-it line, keeps its look for the arrival, and runs it once the pause is over', async () => {
    let now = '2026-10-08T09:00:00';
    const ticking = {
      today: () => now.slice(0, 10),
      localNow: () => now,
      now: () => Date.parse(`${now}Z`),
    };
    const vault = memoryVault(
      {
        [ASK_RULE]: ASK_RULE_TEXT,
        '.atlas/prompts/actions.md': 'List the action items.\n',
        [MEETING]: LET_IN,
      },
      { [ASK_RULE]: 100, [MEETING]: 200 },
    );
    const claude = fakeClaudeStepPorts({
      status: NOT_LOGGED_IN,
      rounds: [[{ type: 'text', text: JSON.stringify({ proposals: [] }) }]],
    });
    const options: AutomationsOptions = {
      offered: EVERY_ENTRY_POINT,
      ports: { ...vault.ports, claude },
      clock: ticking,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity: recordingActivity(),
      onSettled: vi.fn(),
      scheduled: true,
    };
    const hook = renderHook((props: AutomationsOptions) => useAutomations(props), {
      initialProps: options,
    });
    await settle();

    const [pause] = [...hook.result.current.pauses.values()];
    expect(pause).toMatchObject({
      failures: 1,
      retryAt: '2026-10-08T09:01:00',
      unavailable: 'Claude Code is installed but not logged in. Fix: claude auth login',
    });
    expect(claude.fake.requests).toHaveLength(0);

    // Logged in, and the minute the pause named comes and goes.
    claude.provider().status = async () => ({ ready: true });
    now = '2026-10-08T09:02:00';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 2);
    });
    await settle();

    expect(claude.fake.requests).toHaveLength(1);
    expect(hook.result.current.pauses.size).toBe(0);
  });
});

describe('useAutomations: a Claude step the status calls ready but whose ask is refused (attack on PR #637)', () => {
  const ASK_RULE = '.atlas/automations/Actions.md';
  const ASK_RULE_TEXT = [
    '---',
    'atlas: automation',
    'name: Actions',
    'enabled: true',
    'when: a meeting is created',
    'which: FROM meeting',
    'do: claude',
    'prompt: .atlas/prompts/actions.md',
    'output: proposals',
    '---',
    '',
  ].join('\n');

  /**
   * A revoked API key, or a Claude Code token that expired: the status reads
   * only what is stored, so it says ready, and every ask is refused with a
   * login problem the step takes for "unreachable".
   */
  const openRefused = (
    rounds: NonNullable<Parameters<typeof fakeClaudeStepPorts>[0]>['rounds'] = refusedRounds(),
  ) => {
    const at = { now: '2026-10-08T09:00:00' };
    const ticking = {
      today: () => at.now.slice(0, 10),
      localNow: () => at.now,
      now: () => Date.parse(`${at.now}Z`),
    };
    const vault = memoryVault(
      {
        [ASK_RULE]: ASK_RULE_TEXT,
        '.atlas/prompts/actions.md': 'List the action items.\n',
        [MEETING]: LET_IN,
      },
      { [ASK_RULE]: 100, [MEETING]: 200 },
    );
    const claude = fakeClaudeStepPorts({ status: { ready: true }, rounds });
    const statusAsked = { count: 0 };
    const provider = claude.provider();
    provider.status = async () => {
      statusAsked.count += 1;
      return { ready: true };
    };
    const activity = recordingActivity();
    const options: AutomationsOptions = {
      offered: EVERY_ENTRY_POINT,
      ports: { ...vault.ports, claude },
      clock: ticking,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity,
      onSettled: vi.fn(),
      scheduled: true,
    };
    const hook = renderHook((props: AutomationsOptions) => useAutomations(props), {
      initialProps: options,
    });
    /** Moves the clock and the timers on by whole minutes, one tick at a time. */
    const minutes = async (count: number) => {
      for (let minute = 0; minute < count; minute += 1) {
        const ms = (Date.parse(`${at.now}Z`) + SCHEDULE_TICK_MS) as number;
        at.now = new Date(ms).toISOString().slice(0, 19);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
        });
        await settle();
      }
    };
    return { at, claude, hook, minutes, provider, statusAsked };
  };
  const refusedRounds = (problem: 'no_key' | 'failed' = 'no_key') =>
    Array.from(
      { length: 40 },
      () => new ModelProviderError(problem, 'The Anthropic API refused the key: invalid x-api-key'),
    );

  it('asks Claude no more often than the backoff allows while every ask is refused', async () => {
    const { claude, hook, minutes } = openRefused();
    await settle();
    expect(claude.fake.requests).toHaveLength(1);
    expect([...hook.result.current.pauses.values()][0]?.unavailable).toBeDefined();

    await minutes(30);

    // Backoff 1, 2, 4, 8, 15 min from 09:00 tries at 09:01, 09:03, 09:07, 09:15 and 09:30: six asks in all.
    expect(claude.fake.requests.length).toBeLessThanOrEqual(6);
  });

  it('counts the failures up while every ask is refused, so the backoff grows', async () => {
    const { hook, minutes } = openRefused();
    await settle();

    await minutes(10);

    expect([...hook.result.current.pauses.values()][0]?.failures ?? 0).toBeGreaterThan(1);
  });

  it('settles an answer Claude failed to give with no pause, and asks again for nothing', async () => {
    const { claude, hook, minutes } = openRefused(refusedRounds('failed'));
    await settle();
    expect(claude.fake.requests).toHaveLength(1);
    expect(hook.result.current.pauses.size).toBe(0);

    await minutes(5);

    expect(claude.fake.requests).toHaveLength(1);
  });

  it('asks the status nothing at the ticks while no rule is held back for Claude', async () => {
    const { claude, hook, minutes, statusAsked } = openRefused([
      [{ type: 'text', text: JSON.stringify({ proposals: [] }) }],
    ]);
    await settle();
    expect(claude.fake.requests).toHaveLength(1);
    expect(hook.result.current.pauses.size).toBe(0);
    const asked = statusAsked.count;

    await minutes(5);

    expect(statusAsked.count - asked).toBe(0);
  });

  it('never waits more than 15 minutes between tries while the status keeps saying logged out', async () => {
    const { at, claude, hook, minutes, provider } = openRefused();
    provider.status = async () => ({
      ready: false,
      problem: 'not_logged_in',
      message: 'Claude Code is installed but not logged in.',
      fix: 'claude auth login',
    });
    // Every try, the open-time one too, is stopped by the status: Claude is never asked.
    await settle();
    let longest = 0;
    let most = 0;
    for (let minute = 0; minute < 90; minute += 1) {
      await minutes(1);
      const pause = [...hook.result.current.pauses.values()][0];
      expect(pause?.unavailable).toBeDefined();
      const wait = (Date.parse(`${pause!.retryAt!}Z`) - Date.parse(`${at.now}Z`)) / 60_000;
      longest = Math.max(longest, wait);
      most = Math.max(most, pause!.failures);
    }

    expect(most).toBeGreaterThan(5);
    expect(longest).toBeLessThanOrEqual(15);
    expect(claude.fake.requests).toHaveLength(0);
  });

  it('asks Claude once for the held news once logged in, however many ticks and rechecks follow', async () => {
    const { claude, hook, minutes, provider } = openRefused([
      [{ type: 'text', text: JSON.stringify({ proposals: [] }) }],
    ]);
    let ready = false;
    provider.status = async () =>
      ready
        ? { ready: true }
        : {
            ready: false,
            problem: 'not_logged_in',
            message: 'Claude Code is installed but not logged in.',
            fix: 'claude auth login',
          };
    await settle();
    await minutes(3);
    expect(claude.fake.requests).toHaveLength(0);

    ready = true;
    await minutes(20);

    expect(claude.fake.requests).toHaveLength(1);
    expect(hook.result.current.pauses.size).toBe(0);
  });
});
