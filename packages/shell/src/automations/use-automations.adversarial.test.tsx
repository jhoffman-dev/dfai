// @vitest-environment jsdom
/**
 * Adversarial pass on the scheduler (P25-02/03): a rule that has never run, whose
 * time only ever falls while DFAI is closed. The vault is held in memory; the clock is the test's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  movedPath,
  parseRunLog,
  type EntryMove,
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
import { SCHEDULE_TICK_MS, useAutomations, type AutomationsOptions } from './use-automations.ts';

const RULE = '.atlas/automations/Sweep.md';
const LOG = '.atlas/automations/log/Sweep.md';

const rule = (when: string) =>
  [
    '---',
    'atlas: automation',
    'name: Sweep',
    'enabled: true',
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
  return { files, ports };
}

let now = '2026-09-27T09:00:00';
const clock = {
  today: () => now.slice(0, 10),
  localNow: () => now,
  now: () => Date.parse(`${now}Z`),
};

function mount(vault: ReturnType<typeof memoryVault>) {
  const options: AutomationsOptions = {
    ports: vault.ports,
    clock,
    vaultKey: '/vaults/home',
    indexKey: '1',
    indexReady: true,
    activity: recordingActivity(),
    onSettled: () => {},
  };
  return renderHook((props: AutomationsOptions) => useAutomations(props), {
    initialProps: options,
  });
}

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

describe('a rule written by hand, never run', () => {
  it('runs by the second day even when DFAI is only ever open outside its time', async () => {
    const vault = memoryVault({
      [RULE]: rule('daily at 03:00'),
      'Tasks/A.md': '---\ntype: task\n---\n',
    });

    // Day one: open from 09:00 to 17:00, then closed overnight.
    const dayOne = mount(vault);
    await settle();
    now = '2026-09-27T17:00:00';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    });
    await settle();
    dayOne.unmount();

    // Day two: 03:00 came and went while DFAI was closed — a run missed, to catch up.
    now = '2026-09-28T09:00:00';
    mount(vault);
    await settle();
    expect(runsIn(vault.files[LOG])).toHaveLength(1);
  });
});
