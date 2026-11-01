// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  digestOf,
  movedPath,
  NOTE_RUNS_PER_HOUR,
  parseRunLog,
  type EntryMove,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import {
  fakeClaudeStepPorts,
  createNoteChanges,
  fakeIndexPort,
  fakeVaultFs,
  type AutomationPorts,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { SCHEDULE_TICK_MS, useAutomations, type AutomationsOptions } from './use-automations.ts';

/**
 * The runner as the app holds it (P25-02): when rules run by themselves — on
 * opening, on the clock, once per time they are due — and that commands go
 * one at a time. The vault is held in memory; the clock is the test's.
 */

const RULE = '.atlas/automations/Sweep.md';
const LOG = '.atlas/automations/log/Sweep.md';

const rule = (when: string, enabled = true) =>
  [
    '---',
    'atlas: automation',
    'name: Sweep',
    `enabled: ${enabled}`,
    `when: ${when}`,
    'which: FROM task',
    'do: archive',
    '---',
    '',
  ].join('\n');

function memoryVault(files: Record<string, string>) {
  const dirs = new Set(['.atlas', '.atlas/automations', 'Tasks']);
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
        modified: 1,
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
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
    readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
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
  // Every task still out of the Archive, whatever was asked: the SQL is the query's business.
  const index = fakeIndexPort({
    query: async () => ({
      columns: ['path', 'title', 'type'],
      rows: Object.keys(files)
        .filter((path) => path.startsWith('Tasks/'))
        .map((path) => [path, path, 'task']),
      truncated: false,
    }),
  });
  const ports = (): AutomationPorts & { notePaths: readonly VaultPath[] } => ({
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
    types: [],
    notePaths: Object.keys(files).map(createVaultPath),
    claude: fakeClaudeStepPorts(),
  });
  return { files, ports };
}

const TASK_TYPE = {
  name: 'task',
  label: 'Task',
  properties: [],
} as unknown as AutomationPorts['types'][number];

let now = '2026-09-27T09:00:00';
const clock = {
  today: () => now.slice(0, 10),
  localNow: () => now,
  now: () => Date.parse(`${now}Z`),
};

function mount(vault: ReturnType<typeof memoryVault>, options: Partial<AutomationsOptions> = {}) {
  const onSettled = vi.fn();
  const initial: AutomationsOptions = {
    ports: { ...vault.ports(), types: [TASK_TYPE] },
    clock,
    vaultKey: '/vaults/home',
    indexKey: '1',
    indexReady: true,
    activity: recordingActivity(),
    onSettled,
    ...options,
  };
  const hook = renderHook((props: AutomationsOptions) => useAutomations(props), {
    initialProps: initial,
  });
  return { hook, onSettled, initial };
}

/** Lets the reads and runs in flight finish, without moving the clock. */
async function settle() {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

const runsIn = (text: string | undefined) =>
  parseRunLog(text ?? '').filter((entry) => entry.kind === 'run' || entry.kind === 'failed');

beforeEach(() => {
  vi.useFakeTimers();
  now = '2026-09-27T09:00:00';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutomations', () => {
  it('runs an on-opening rule once the index is ready, and only once', async () => {
    const vault = memoryVault({
      [RULE]: rule('on app open'),
      'Tasks/A.md': '---\ntype: task\n---\n',
    });
    const { hook, initial } = mount(vault, { indexReady: false });
    await settle();
    expect(vault.files['Tasks/A.md']).toBeDefined();

    hook.rerender({ ...initial, indexReady: true });
    await settle();
    expect(vault.files['Archive/Tasks/A.md']).toBeDefined();
    expect(runsIn(vault.files[LOG]).map((entry) => entry.kind === 'run' && entry.trigger)).toEqual([
      'open',
    ]);

    // The clock coming round, and the index moving, start no second run.
    hook.rerender({ ...initial, indexReady: true, indexKey: '2' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 3);
    });
    await settle();
    expect(runsIn(vault.files[LOG])).toHaveLength(1);
  });

  it('runs nothing by the clock on a Mac a synced vault does not name, but still by hand (U-29)', async () => {
    const vault = memoryVault({
      [RULE]: rule('on app open'),
      'Tasks/A.md': '---\ntype: task\n---\n',
    });
    const { hook, initial } = mount(vault, { scheduled: false });
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 2);
    });
    await settle();
    expect(vault.files['Tasks/A.md']).toBeDefined();
    expect(runsIn(vault.files[LOG])).toHaveLength(0);

    // Named here now: the clock runs it.
    hook.rerender({ ...initial, scheduled: true });
    await settle();
    expect(vault.files['Archive/Tasks/A.md']).toBeDefined();
  });

  it('catches up a daily run missed while DFAI was closed, once', async () => {
    const turnedOn = [
      '---\natlas: automation-log\n---\n\n# Sweep — run log\n',
      '## 2026-09-26 14:00:00 · Turned on\n\nIt runs on its schedule from here on.\n',
    ].join('\n');
    const vault = memoryVault({
      [RULE]: rule('daily at 03:00'),
      [LOG]: turnedOn,
      'Tasks/A.md': '---\ntype: task\n---\n',
    });
    mount(vault);
    await settle();
    expect(runsIn(vault.files[LOG]).map((entry) => entry.kind === 'run' && entry.trigger)).toEqual([
      'schedule',
    ]);
    now = '2026-09-27T12:00:00';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 2);
    });
    await settle();
    expect(runsIn(vault.files[LOG])).toHaveLength(1);
  });

  it('runs an hourly rule when the minute comes round after its time', async () => {
    const vault = memoryVault({
      [RULE]: rule('every 1 hour'),
      'Tasks/A.md': '---\ntype: task\n---\n',
    });
    mount(vault);
    await settle();
    // Never run, it is marked as first seen and counts from then: nothing is due yet (A25-01).
    expect(parseRunLog(vault.files[LOG] ?? '').map((entry) => entry.kind)).toEqual(['seen']);

    now = '2026-09-27T10:00:30';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    });
    await settle();
    expect(runsIn(vault.files[LOG]).map((entry) => entry.kind === 'run' && entry.trigger)).toEqual([
      'schedule',
    ]);
  });

  it('never runs a rule that is off, and turning it on logs it', async () => {
    const vault = memoryVault({
      [RULE]: rule('on app open', false),
      'Tasks/A.md': '---\ntype: task\n---\n',
    });
    const { hook, onSettled } = mount(vault);
    await settle();
    expect(vault.files[LOG]).toBeUndefined();
    const loaded = hook.result.current.listing?.automations[0];
    expect(loaded?.rule.enabled).toBe(false);

    await act(async () => {
      await hook.result.current.setEnabled(loaded!.rule, true);
    });
    await settle();
    expect(vault.files[RULE]).toContain('enabled: true');
    expect(parseRunLog(vault.files[LOG] ?? '').map((entry) => entry.kind)).toEqual(['turnedOn']);
    expect(onSettled).toHaveBeenCalled();
    expect(hook.result.current.listing?.automations[0]?.rule.enabled).toBe(true);
  });

  it('runs by hand and undoes, one command at a time', async () => {
    const vault = memoryVault({ [RULE]: rule('manually'), 'Tasks/A.md': '---\ntype: task\n---\n' });
    const { hook } = mount(vault);
    await settle();
    const target = hook.result.current.listing!.automations[0]!.rule;

    let second: unknown = 'not yet';
    await act(async () => {
      const first = hook.result.current.runNow(target);
      // A second command while the first is under way is refused, not queued.
      second = await hook.result.current.runNow(target);
      await first;
    });
    expect(second).toBeNull();
    expect(vault.files['Archive/Tasks/A.md']).toBeDefined();
    expect(runsIn(vault.files[LOG])).toHaveLength(1);

    await act(async () => {
      await hook.result.current.undo(target);
    });
    expect(vault.files['Tasks/A.md']).toBeDefined();
    expect(vault.files['Archive/Tasks/A.md']).toBeUndefined();
  });

  it('shows no rules, and runs none, for a vault other than the one they were read from', async () => {
    const vault = memoryVault({ [RULE]: rule('manually') });
    const { hook, initial } = mount(vault);
    await settle();
    expect(hook.result.current.listing?.automations).toHaveLength(1);
    hook.rerender({ ...initial, vaultKey: null });
    expect(hook.result.current.listing).toBeNull();
    let ran: unknown = 'not yet';
    await act(async () => {
      ran = await hook.result.current.runNow({
        id: 'Sweep',
        path: createVaultPath(RULE),
        name: 'Sweep',
        enabled: true,
        when: { kind: 'manual' },
        which: 'FROM task',
        olderThanDays: null,
        action: { kind: 'archive' },
      });
    });
    expect(ran).toBeNull();
    expect(vault.files[LOG]).toBeUndefined();
  });

  it('says why a command failed', async () => {
    const vault = memoryVault({ [RULE]: rule('manually'), 'Tasks/A.md': '---\ntype: task\n---\n' });
    const ports = vault.ports();
    const failing = {
      ...ports,
      types: [TASK_TYPE],
      fs: {
        ...ports.fs,
        createNote: async () => {
          throw new Error('The disk is full.');
        },
      },
    };
    const { hook } = mount(vault, { ports: failing });
    await settle();
    await act(async () => {
      await hook.result.current.runNow(hook.result.current.listing!.automations[0]!.rule);
    });
    expect(hook.result.current.notice).toBe('Its log could not be written (The disk is full.).');
    expect(hook.result.current.busy).toBe(false);
  });
});

describe('useAutomations: rules a note sets off (P29-01)', () => {
  const VAULT = '/vaults/home';
  const TASK = 'Tasks/A.md';
  const onNewTask = () => rule('a task is created');
  const added = (vault: ReturnType<typeof memoryVault>, path: string, vaultKey = VAULT) => ({
    vault: vaultKey,
    changes: [
      { kind: 'added' as const, path, type: 'task', digest: digestOf(vault.files[path] ?? '') },
    ],
  });

  it('runs a rule when the feed says a note of its type arrived, once per version', async () => {
    const vault = memoryVault({ [RULE]: onNewTask(), [TASK]: '---\ntype: task\n---\n' });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    mount(vault, { changes });
    await settle();
    expect(vault.files[TASK]).toBeDefined();
    const news = added(vault, TASK);

    act(() => changes.publish(news));
    await settle();
    expect(vault.files[`Archive/${TASK}`]).toBeDefined();
    expect(runsIn(vault.files[LOG]).map((entry) => entry.kind === 'run' && entry.trigger)).toEqual([
      'note',
    ]);

    act(() => changes.publish(news));
    await settle();
    expect(runsIn(vault.files[LOG])).toHaveLength(1);
  });

  it('holds news heard before the index is ready, and runs on it once it is', async () => {
    const vault = memoryVault({ [RULE]: onNewTask(), [TASK]: '---\ntype: task\n---\n' });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const { hook, initial } = mount(vault, { changes, indexReady: false });
    act(() => changes.publish(added(vault, TASK)));
    await settle();
    expect(vault.files[TASK]).toBeDefined();

    hook.rerender({ ...initial, changes, indexReady: true });
    await settle();
    expect(vault.files[`Archive/${TASK}`]).toBeDefined();
  });

  it('runs news held while the index opens once each, in the order it was heard (#92)', async () => {
    const [first, second] = ['Tasks/A.md', 'Tasks/B.md'];
    const vault = memoryVault({
      [RULE]: onNewTask(),
      [first]: '---\ntype: task\n---\n',
      [second]: '---\ntype: task\n---\n',
    });
    // The query asked among the notes a run heard of answers for those alone, as SQL does.
    const held = vault.ports();
    const ports = {
      ...held,
      types: [TASK_TYPE],
      index: {
        ...held.index,
        query: async (sql: string, parameters: readonly (string | number | null)[]) => {
          const result = await held.index.query(sql, parameters);
          const named = parameters.filter((each) => typeof each === 'string');
          return { ...result, rows: result.rows.filter((row) => named.includes(String(row[0]))) };
        },
      },
    };
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const { hook, initial } = mount(vault, { changes, ports, indexReady: false });
    act(() => changes.publish(added(vault, first)));
    act(() => changes.publish(added(vault, second)));
    await settle();
    expect(vault.files[LOG]).toBeUndefined();

    // The index opens, and is busy and ready again with each sync after.
    for (const indexReady of [true, false, true]) {
      hook.rerender({ ...initial, changes, indexReady });
      await settle();
    }
    const triggeredBy = runsIn(vault.files[LOG]).map((entry) =>
      entry.kind === 'run'
        ? entry.done.map((action) => action.kind === 'archived' && action.from)
        : [],
    );
    expect(triggeredBy).toEqual([[first], [second]]);
  });

  it('runs nothing on a Mac that does not run the vault’s automations', async () => {
    const vault = memoryVault({ [RULE]: onNewTask(), [TASK]: '---\ntype: task\n---\n' });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    mount(vault, { changes, scheduled: false });
    await settle();

    act(() => changes.publish(added(vault, TASK)));
    await settle();
    expect(vault.files[TASK]).toBeDefined();
    expect(vault.files[LOG]).toBeUndefined();
  });

  it('lets go of news of a vault that is not the one open', async () => {
    const vault = memoryVault({ [RULE]: onNewTask(), [TASK]: '---\ntype: task\n---\n' });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    mount(vault, { changes });
    await settle();

    act(() => changes.publish(added(vault, TASK, '/vaults/work')));
    await settle();
    expect(vault.files[TASK]).toBeDefined();
    expect(vault.files[LOG]).toBeUndefined();
  });

  it('holds a rule that has run as often this hour as one may, once, then runs what it heard', async () => {
    const full = Array.from(
      { length: NOTE_RUNS_PER_HOUR },
      (_, at) =>
        `## 2026-09-27 08:${String(10 + at).padStart(2, '0')}:00 · Ran when a note appeared or changed\n\n` +
        `Archived 1 note.\n\n- archived \`"Tasks/O${at}.md"\` → \`"Archive/Tasks/O${at}.md"\`\n`,
    );
    const log = ['---\natlas: automation-log\n---\n\n# Sweep — run log\n', ...full].join('\n');
    const vault = memoryVault({
      [RULE]: onNewTask(),
      [LOG]: log,
      [TASK]: '---\ntype: task\n---\n',
    });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const { hook, initial } = mount(vault, { changes });
    await settle();

    act(() => changes.publish(added(vault, TASK)));
    await settle();
    act(() => changes.publish(added(vault, TASK)));
    await settle();
    // Not tried again while held: one line in Activity, not one per sync heard.
    const reports = (initial.activity as ReturnType<typeof recordingActivity>).reports;
    expect(reports.filter((report) => report.level === 'error')).toHaveLength(1);
    expect(vault.files[TASK]).toBeDefined();
    expect(vault.files[LOG]).toBe(log);
    // Held for the hour, not failing: one pause, no failure counted however much it hears.
    expect(hook.result.current.pauses.get('Sweep')).toEqual({
      reason:
        'Held back: It has used its 20 runs, or questions put to Claude, for the last hour, ' +
        'the most a rule may. It runs on what changed meanwhile at 09:10.',
      failures: 0,
      retryAt: '2026-09-27T09:10:00',
    });

    now = '2026-09-27T09:11:00';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    });
    await settle();
    expect(vault.files[`Archive/${TASK}`]).toBeDefined();
    expect(runsIn(vault.files[LOG])).toHaveLength(NOTE_RUNS_PER_HOUR + 1);
  });

  it('drops news on a Mac known not to run the automations, and holds it while that is unknown', async () => {
    const vault = memoryVault({ [RULE]: onNewTask(), [TASK]: '---\ntype: task\n---\n' });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const { hook, initial } = mount(vault, { changes, scheduled: null });
    await settle();
    act(() => changes.publish(added(vault, TASK)));
    await settle();
    expect(vault.files[TASK]).toBeDefined();

    hook.rerender({ ...initial, changes, scheduled: true });
    await settle();
    expect(vault.files[`Archive/${TASK}`]).toBeDefined();
  });

  it('keeps nothing heard on a Mac known not to run them, even if it is named later', async () => {
    const vault = memoryVault({ [RULE]: onNewTask(), [TASK]: '---\ntype: task\n---\n' });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const { hook, initial } = mount(vault, { changes, scheduled: false });
    await settle();
    act(() => changes.publish(added(vault, TASK)));
    await settle();

    hook.rerender({ ...initial, changes, scheduled: true });
    await settle();
    expect(vault.files[TASK]).toBeDefined();
    expect(vault.files[LOG]).toBeUndefined();
  });
});

describe('useAutomations: rules a note sets off, attacked (P29-01)', () => {
  const VAULT = '/vaults/home';
  const TASK = 'Tasks/A.md';
  const onNewTask = () => rule('a task is created');
  const added = (vault: ReturnType<typeof memoryVault>, path: string, vaultKey = VAULT) => ({
    vault: vaultKey,
    changes: [
      { kind: 'added' as const, path, type: 'task', digest: digestOf(vault.files[path] ?? '') },
    ],
  });

  it('runs on a note’s news once a rule held back by a failure is tried again, as its pause says', async () => {
    const vault = memoryVault({ [RULE]: onNewTask(), [TASK]: '---\ntype: task\n---\n' });
    const base = vault.ports();
    let failing = true;
    const fs = {
      ...base.fs,
      listNotes: async (...args: Parameters<typeof base.fs.listNotes>) => {
        if (failing) throw new Error('the disk was busy');
        return base.fs.listNotes(...args);
      },
    };
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const { hook } = mount(vault, { changes, ports: { ...base, fs, types: [TASK_TYPE] } });
    await settle();

    act(() => changes.publish(added(vault, TASK)));
    await settle();
    expect(vault.files[TASK]).toBeDefined();
    expect(hook.result.current.pauses.get('Sweep')?.reason).toMatch(/it is tried again at 09:01/);

    // The disk recovers, and the time the pause named comes and goes.
    failing = false;
    now = '2026-09-27T09:05:00';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 5);
    });
    await settle();

    expect(vault.files[`Archive/${TASK}`]).toBeDefined();
  });

  it('never runs one vault’s rule on another vault opened while its news waited its turn', async () => {
    const vault = memoryVault({ [RULE]: onNewTask(), [TASK]: '---\ntype: task\n---\n' });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const { hook, initial } = mount(vault, { changes });
    await settle();
    // A save from the editor holds the one door while the news comes in.
    let release = () => {};
    const holding = new Promise<void>((resolve) => (release = resolve));
    let held: Promise<unknown> = Promise.resolve();
    act(() => {
      held = hook.result.current.exclusive(() => holding, { wait: true });
    });
    act(() => changes.publish(added(vault, TASK)));
    await settle();

    // The work vault is opened: the ports now read and write it. It has no rules, and its own Tasks/A.md.
    const workTask = '---\ntype: task\n---\nWork notes kept by Tobias Fenn.\n';
    delete vault.files[RULE];
    vault.files[TASK] = workTask;
    hook.rerender({ ...initial, changes, vaultKey: '/vaults/work' });
    await settle();
    release();
    await act(async () => {
      await held;
    });
    await settle();

    expect(vault.files[TASK]).toBe(workTask);
    expect(vault.files[`Archive/${TASK}`]).toBeUndefined();
    expect(vault.files[LOG]).toBeUndefined();
  });
});

describe('useAutomations: rules a note sets off, attacked again (round 2)', () => {
  const VAULT = '/vaults/home';
  const onNewTask = () => rule('a task is created');
  const added = (vault: ReturnType<typeof memoryVault>, path: string) => ({
    vault: VAULT,
    changes: [
      { kind: 'added' as const, path, type: 'task', digest: digestOf(vault.files[path] ?? '') },
    ],
  });

  it('runs none of a rule’s held news once this Mac is known not to run the vault’s automations', async () => {
    const first = 'Tasks/A.md';
    const second = 'Tasks/B.md';
    const vault = memoryVault({
      [RULE]: onNewTask(),
      [first]: '---\ntype: task\n---\n',
      [second]: '---\ntype: task\n---\nFor Mara Quill.\n',
    });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const { hook, initial } = mount(vault, { changes, scheduled: true });
    await settle();
    // A save from the editor holds the one door while two syncs' news comes in and is queued.
    let release = () => {};
    const holding = new Promise<void>((resolve) => (release = resolve));
    let held: Promise<unknown> = Promise.resolve();
    act(() => {
      held = hook.result.current.exclusive(() => holding, { wait: true });
    });
    act(() => changes.publish(added(vault, first)));
    act(() => changes.publish(added(vault, second)));
    await settle();

    // Sync settings now name the other Mac as the one that runs this vault's automations.
    hook.rerender({ ...initial, changes, scheduled: false });
    await settle();
    release();
    await act(async () => {
      await held;
    });
    await settle();

    // "False drops": what was held is let go, not run here as well as on the other Mac.
    expect(vault.files[second]).toBeDefined();
    expect(vault.files[`Archive/${second}`]).toBeUndefined();
    expect(vault.files[first]).toBeDefined();
    expect(vault.files[LOG]).toBeUndefined();
  });
});
