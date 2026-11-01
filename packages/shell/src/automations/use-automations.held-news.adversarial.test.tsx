// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  digestOf,
  movedPath,
  NOTE_RUNS_PER_HOUR,
  type EntryMove,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import {
  createNoteChanges,
  fakeClaudeStepPorts,
  fakeIndexPort,
  fakeVaultFs,
  recordingActivity,
  type AutomationPorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import {
  HELD_NEWS,
  SCHEDULE_TICK_MS,
  useAutomations,
  type AutomationsOptions,
} from './use-automations.ts';

/**
 * Adversarial pass over what a rule a note sets off is holding while it is
 * held back (ADR-0028): a burst of arrivals — thirty meetings pulled at once,
 * each stamped in its own sync — is more news than the rule may run on in the
 * hour, and more than it keeps. The pause says "It runs on what changed
 * meanwhile"; this asks whether that is so, or at least whether anything
 * says what was let go. Tasks and an archive rule stand in for meetings and
 * a Claude step: the queue is the same for every rule a note sets off.
 *
 * Fails on p29-03.
 */

const VAULT = '/vaults/home';
const RULE = '.atlas/automations/Sweep.md';
const LOG = '.atlas/automations/log/Sweep.md';

const RULE_TEXT = [
  '---',
  'atlas: automation',
  'name: Sweep',
  'enabled: true',
  'when: a task is created',
  'which: FROM task',
  'do: archive',
  '---',
  '',
].join('\n');

/** A log of as many runs as an hour allows, all within the last hour. */
const FULL_LOG = [
  '---\natlas: automation-log\n---\n\n# Sweep — run log\n',
  ...Array.from(
    { length: NOTE_RUNS_PER_HOUR },
    (_, at) =>
      `## 2026-09-27 08:${String(10 + at).padStart(2, '0')}:00 · Ran when a note appeared or changed\n\n` +
      `Archived 1 note.\n\n- archived \`"Tasks/O${at}.md"\` → \`"Archive/Tasks/O${at}.md"\`\n`,
  ),
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
  // The tasks a run asks among, still out of the Archive: asked among the notes it heard of, as SQL answers.
  const index = fakeIndexPort({
    query: async (_sql, parameters) => ({
      columns: ['path', 'title', 'type'],
      rows: Object.keys(files)
        .filter((path) => path.startsWith('Tasks/') && parameters.includes(path))
        .map((path) => [path, path, 'task']),
      truncated: false,
    }),
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
    types: [{ name: 'task', label: 'Task', properties: [] } as never],
    get notePaths() {
      return Object.keys(files).map(createVaultPath);
    },
    claude: fakeClaudeStepPorts(),
  };
  return { files, ports };
}

let now = '2026-09-27T09:00:00';
const clock = {
  today: () => now.slice(0, 10),
  localNow: () => now,
  now: () => Date.parse(`${now}Z`),
};

async function settle() {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

/** The clock moves to `at` and the minute's tick comes round, as often as a held queue needs to drain. */
async function comeTo(at: string) {
  now = at;
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    });
    await settle();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  now = '2026-09-27T09:00:00';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutomations: a rule held back while more arrives than it keeps', () => {
  it('runs on every note it heard meanwhile, or says in Activity that some were let go', async () => {
    const arrivals = Array.from(
      { length: HELD_NEWS + 1 },
      (_, at) => `Tasks/T${String(at).padStart(2, '0')}.md`,
    );
    const vault = memoryVault({
      [RULE]: RULE_TEXT,
      [LOG]: FULL_LOG,
      ...Object.fromEntries(arrivals.map((path) => [path, '---\ntype: task\n---\n'])),
    });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const activity = recordingActivity();
    const options: AutomationsOptions = {
      ports: vault.ports,
      clock,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity,
      onSettled: vi.fn(),
      changes,
    };
    renderHook((props: AutomationsOptions) => useAutomations(props), { initialProps: options });
    await settle();

    // Each arrival in a sync of its own, while the rule has run as often this hour as it may.
    for (const path of arrivals) {
      const digest = digestOf(vault.files[path] ?? '');
      act(() =>
        changes.publish({
          vault: VAULT,
          changes: [{ kind: 'added', path, type: 'task', digest }],
        }),
      );
      await settle();
    }
    // Held, and saying it will come back to them: "It runs on what changed meanwhile at 09:10."
    expect(arrivals.filter((path) => vault.files[path] !== undefined)).toEqual(arrivals);
    expect(activity.reports.map((report) => report.message).join('\n')).toContain(
      'It runs on what changed meanwhile',
    );

    // The hour passes, and the next: time for every held run, twenty an hour.
    await comeTo('2026-09-27T10:00:00');
    await comeTo('2026-09-27T11:01:00');
    await comeTo('2026-09-27T12:02:00');

    const neverRunOn = arrivals.filter((path) => vault.files[path] !== undefined);
    const saidSo = activity.reports.some((report) => /let go|by hand/i.test(report.message));
    // Sanity: the queue did drain — most of what waited was run on.
    expect(neverRunOn.length).toBeLessThan(arrivals.length);
    expect(neverRunOn.length === 0 || saidSo).toBe(true);
  });

  it('says in Activity and in the rule’s log how much it let go, and that a run by hand takes it', async () => {
    const arrivals = Array.from(
      { length: HELD_NEWS + 3 },
      (_, at) => `Tasks/T${String(at).padStart(2, '0')}.md`,
    );
    const vault = memoryVault({
      [RULE]: RULE_TEXT,
      [LOG]: FULL_LOG,
      ...Object.fromEntries(arrivals.map((path) => [path, '---\ntype: task\n---\n'])),
    });
    const changes = createNoteChanges({ onError: (cause) => void cause });
    const activity = recordingActivity();
    const options: AutomationsOptions = {
      ports: vault.ports,
      clock,
      vaultKey: VAULT,
      indexKey: '1',
      indexReady: true,
      activity,
      onSettled: vi.fn(),
      changes,
    };
    renderHook((props: AutomationsOptions) => useAutomations(props), { initialProps: options });
    await settle();
    for (const path of arrivals) {
      const digest = digestOf(vault.files[path] ?? '');
      act(() =>
        changes.publish({ vault: VAULT, changes: [{ kind: 'added', path, type: 'task', digest }] }),
      );
      await settle();
    }

    // The minute comes round while it is still held back: what it let go is said once, with its count.
    await comeTo('2026-09-27T09:01:00');

    const said = activity.reports.filter((report) => report.message.includes('Let news go'));
    expect(said.map(({ level, message }) => [level, message])).toEqual([
      [
        'warning',
        'Sweep: Let news go. Let go of the news of 3 syncs: more arrived than it holds while it cannot run. Run it by hand to take the notes they named.',
      ],
    ]);
    expect(vault.files[LOG]).toContain('· Let news go');
    expect(vault.files[LOG]).toContain('- let go `3`');
  });
});
