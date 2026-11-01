// @vitest-environment jsdom
/**
 * A25-01's review findings on the runner as the app holds it: a rule whose log
 * cannot be written is paused and says why, a rule that keeps failing backs
 * off, an editor save waits its turn instead of vanishing, and a note saved
 * elsewhere does not re-read every rule and log. The vault is held in memory;
 * the clock is the test's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  movedPath,
  type EntryMove,
  type LogEntry,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import {
  fakeClaudeStepPorts,
  fakeIndexPort,
  fakeVaultFs,
  type AutomationPorts,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { automationRows } from './automation-rows.ts';
import { SCHEDULE_TICK_MS, useAutomations, type AutomationsOptions } from './use-automations.ts';

const RULE = '.atlas/automations/Sweep.md';
const LOG = '.atlas/automations/log/Sweep.md';

const rule = (when: string) =>
  [
    '---',
    'atlas: automation',
    'id: Sweep',
    'name: Sweep',
    'enabled: true',
    `when: ${when}`,
    'which: FROM task',
    'do: archive',
    '---',
    '',
  ].join('\n');

/** A log whose last mark is an hour before the test starts: an hourly rule is due. */
const DUE_LOG = [
  '---\natlas: automation-log\n---\n\n# Sweep — run log\n',
  '## 2026-09-27 08:00:00 · Turned on\n\nIt runs on its schedule from here on.\n',
].join('\n');

function memoryVault(files: Record<string, string>) {
  const faults = { logWrites: false, listNotes: false };
  const counts = { readNotes: 0, listNotes: 0 };
  const dirs = new Set(['.atlas', '.atlas/automations', '.atlas/automations/log', 'Tasks']);
  const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const entry = (path: string, kind: VaultEntry['kind']) =>
    ({
      kind,
      name: path.slice(path.lastIndexOf('/') + 1),
      path: createVaultPath(path),
    }) as VaultEntry;
  const refuseLog = (path: string) => {
    if (faults.logWrites && path.startsWith('.atlas/automations/log/')) {
      throw new Error('The disk is full.');
    }
  };
  const fs = fakeVaultFs({
    listNotes: async () => {
      counts.listNotes += 1;
      if (faults.listNotes) throw new Error('The vault could not be read.');
      return Object.keys(files).map((path) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        path: createVaultPath(path),
        modified: 1,
        size: 1,
      }));
    },
    listDirectory: async (at) => [
      ...[...dirs].filter((dir) => parent(dir) === at).map((dir) => entry(dir, 'directory')),
      ...Object.keys(files)
        .filter((file) => parent(file) === at)
        .map((file) => entry(file, 'file')),
    ],
    readNotes: async (paths) => {
      counts.readNotes += 1;
      return paths.flatMap((path) => {
        const text = files[path];
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      });
    },
    readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
    createFolder: async ({ path }) => void dirs.add(path),
    createNote: async ({ path, contents }) => {
      refuseLog(path);
      files[path] = contents;
      return 0;
    },
    writeTextFile: async ({ path, contents }) => {
      refuseLog(path);
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
    types: [
      {
        name: 'task',
        label: 'Task',
        properties: [],
      } as unknown as AutomationPorts['types'][number],
    ],
    notePaths: Object.keys(files).map(createVaultPath),
    claude: fakeClaudeStepPorts(),
  };
  return { files, ports, faults, counts };
}

let now = '2026-09-27T09:00:00';
const clock = {
  today: () => now.slice(0, 10),
  localNow: () => now,
  now: () => Date.parse(`${now}Z`),
};

function mount(vault: ReturnType<typeof memoryVault>, options: Partial<AutomationsOptions> = {}) {
  const initial: AutomationsOptions = {
    ports: vault.ports,
    clock,
    vaultKey: '/vaults/home',
    indexKey: '1',
    indexReady: true,
    activity: recordingActivity(),
    onSettled: () => {},
    ...options,
  };
  const hook = renderHook((props: AutomationsOptions) => useAutomations(props), {
    initialProps: initial,
  });
  return { hook, initial };
}

async function settle() {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Moves the clock on a minute, and lets the tick's reads and runs finish. */
async function nextMinute() {
  const [date, time] = now.split('T') as [string, string];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const total = hour * 60 + minute + 1;
  now = `${date}T${pad(Math.floor(total / 60))}:${pad(total % 60)}:00`;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
  });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  now = '2026-09-27T09:00:00';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a rule whose log cannot be written', () => {
  it('is paused, says why, and is not tried again every minute', async () => {
    const vault = memoryVault({
      [RULE]: rule('every 1 hour'),
      [LOG]: DUE_LOG,
      'Tasks/A.md': '---\ntype: task\n---\n',
    });
    vault.faults.logWrites = true;
    const { hook } = mount(vault);
    await settle();
    // It ran, and its log refused the entry.
    expect(vault.files['Archive/Tasks/A.md']).toBeDefined();
    const listed = vault.counts.listNotes;
    vault.files['Tasks/B.md'] = '---\ntype: task\n---\n';

    for (let minute = 0; minute < 5; minute += 1) await nextMinute();
    expect(vault.counts.listNotes).toBe(listed);
    expect(vault.files['Tasks/B.md']).toBeDefined();

    const [row] = automationRows(hook.result.current.listing!, {
      watchingSince: hook.result.current.watchingSince!,
      now,
      pauses: hook.result.current.pauses,
    });
    expect(row?.notice).toMatch(/Paused.*log could not be written.*The disk is full/);
    expect(row?.nextRun).toBeNull();
  });

  it('runs again once run by hand, and the pause is lifted when that is logged', async () => {
    const vault = memoryVault({
      [RULE]: rule('every 1 hour'),
      [LOG]: DUE_LOG,
      'Tasks/A.md': '---\ntype: task\n---\n',
    });
    vault.faults.logWrites = true;
    const { hook } = mount(vault);
    await settle();
    expect(hook.result.current.pauses.size).toBe(1);
    vault.faults.logWrites = false;
    await act(async () => {
      await hook.result.current.runNow(hook.result.current.listing!.automations[0]!.rule);
    });
    await settle();
    expect(hook.result.current.pauses.size).toBe(0);
  });
});

describe('a rule that fails without its log saying so', () => {
  it('backs off: tried after one minute, then two, then four', async () => {
    const vault = memoryVault({ [RULE]: rule('every 1 hour'), [LOG]: DUE_LOG });
    vault.faults.listNotes = true;
    mount(vault);
    await settle();
    expect(vault.counts.listNotes).toBe(1);
    for (let minute = 0; minute < 6; minute += 1) await nextMinute();
    // Minutes 1 and 3 retry; 2, 4, 5 and 6 wait. Every minute would be seven.
    expect(vault.counts.listNotes).toBe(3);
  });
});

describe('an editor save while a run is under way', () => {
  it('waits its turn rather than being dropped', async () => {
    const vault = memoryVault({ [RULE]: rule('manually'), 'Tasks/A.md': '---\ntype: task\n---\n' });
    const { hook } = mount(vault);
    await settle();
    const target = hook.result.current.listing!.automations[0]!.rule;
    let saved: unknown = 'not yet';
    await act(async () => {
      const run = hook.result.current.runNow(target);
      saved = await hook.result.current.exclusive(async () => 'saved', { wait: true });
      await run;
    });
    expect(saved).toBe('saved');
  });
});

describe('rules and logs are read again', () => {
  it('not on every note saved elsewhere while the page is closed, but on the next tick', async () => {
    const vault = memoryVault({ [RULE]: rule('manually') });
    const { hook, initial } = mount(vault);
    await settle();
    const reads = vault.counts.readNotes;
    for (const key of ['2', '3', '4']) {
      hook.rerender({ ...initial, indexKey: key });
      await settle();
    }
    expect(vault.counts.readNotes).toBe(reads);
    await nextMinute();
    expect(vault.counts.readNotes).toBeGreaterThan(reads);
  });

  it('on every index change while the page is open, so a hand edit shows at once', async () => {
    const vault = memoryVault({ [RULE]: rule('manually') });
    const { hook, initial } = mount(vault, { live: true });
    await settle();
    vault.files[RULE] = rule('manually').replace('name: Sweep', 'name: Sweeper');
    hook.rerender({ ...initial, live: true, indexKey: '2' });
    await settle();
    expect(hook.result.current.listing?.automations[0]?.rule.name).toBe('Sweeper');
  });
});

describe('a rule whose log has a mark later than now', () => {
  it('says so on its row, and counts its next run from before it', () => {
    const ahead: LogEntry = { kind: 'turnedOn', at: '2026-10-27T03:00:00' };
    const [row] = automationRows(
      {
        automations: [
          {
            rule: {
              id: 'Sweep',
              path: createVaultPath(RULE),
              name: 'Sweep',
              enabled: true,
              when: { kind: 'daily', at: '03:00' },
              which: 'FROM task',
              olderThanDays: null,
              action: { kind: 'archive' },
            },
            log: [ahead],
            idWritten: true,
          },
        ],
        broken: [],
      },
      { watchingSince: '2026-09-27T09:00:00', now: '2026-09-27T09:00:00', pauses: new Map() },
    );
    expect(row?.notice).toMatch(/27 Oct 2026.*later than now/);
    expect(row?.nextRun).toBe('28 Sep 2026, 03:00');
  });
});
