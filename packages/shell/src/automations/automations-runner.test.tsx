// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import {
  createVaultPath,
  digestOf,
  movedPath,
  parseRunLog,
  type NoteChange,
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
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { createAutomationRelay } from '../api/automation-relay.ts';
import { AutomationsRunner, type AutomationsRunnerProps } from './automations-runner.tsx';
import { createAutomationsStore } from './automations-store.ts';
import { createSyncStore, publishSync } from '../sync/sync-store.ts';
import type { SyncController } from '../sync/use-sync.ts';

/** Sync as the Mac that runs the vault's automations sees it, with nothing held for a pull. */
function syncHere() {
  const sync = createSyncStore();
  publishSync(sync, VAULT, {
    phase: { kind: 'unknown' },
    thisMac: 'Studio',
    settings: {},
    automationsHere: true,
    syncedThisSession: new Set(),
    syncPulls: new Map(),
    pulledFiles: { standing: null, acts: async () => true },
  } as unknown as SyncController);
  return sync;
}

/**
 * The automations as the window runs them since #326: in their own runner,
 * which says where they stand in a store. A rule a note sets off still runs
 * on every sync's news of that note, and on nothing else; the page's list is
 * read again for news of the rules alone; and none of it draws the window.
 */

const VAULT = '/vaults/home';
const RULE = '.atlas/automations/Sweep.md';
const LOG = '.atlas/automations/log/Sweep.md';
const TASK = 'Tasks/A.md';

const rule = (name: string) =>
  [
    '---',
    'atlas: automation',
    `name: ${name}`,
    'enabled: true',
    'when: a task is created',
    'which: FROM task',
    'do: archive',
    '---',
    '',
  ].join('\n');

/** A vault in memory whose index lists every task still out of the Archive. */
function memoryVault(files: Record<string, string>) {
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = files[path];
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
    readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
    createFolder: async () => {},
    createNote: async ({ path, contents }) => {
      files[path] = contents;
      return 0;
    },
    writeTextFile: async ({ path, contents }) => {
      files[path] = contents;
      return 1;
    },
    moveEntry: async (move) => {
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
    notePaths: [createVaultPath(RULE), createVaultPath(TASK)],
    claude: fakeClaudeStepPorts(),
  };
  return { files, ports };
}

const clock = {
  today: () => '2026-09-27',
  localNow: () => '2026-09-27T09:00:00',
  now: () => Date.parse('2026-09-27T09:00:00Z'),
};

const runsIn = (text: string | undefined) =>
  parseRunLog(text ?? '').filter((entry) => entry.kind === 'run' || entry.kind === 'failed');

/** Lets the reads and runs in flight finish, without moving the clock. */
async function settle() {
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

/** The runner under a window that counts its own draws, with the index's news to tell by hand. */
function mountRunner(vault: ReturnType<typeof memoryVault>, live = false) {
  const status = createIndexStatusStore();
  status.setState({ vault: VAULT, phase: 'ready', revision: 1 });
  const { client, wrapper: Wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const store = createAutomationsStore();
  const relay = createAutomationRelay();
  const changes = createNoteChanges({ onError: (cause) => void cause });
  const windowDraws = { count: 0 };
  let showPage: (shown: boolean) => void = () => {};
  const props: Omit<AutomationsRunnerProps, 'live'> = {
    store,
    status,
    relay,
    sync: syncHere(),
    ownerKnown: true,
    ports: vault.ports,
    clock,
    vaultKey: VAULT,
    indexReady: true,
    activity: recordingActivity(),
    onSettled: () => {},
    changes,
  };
  function Window() {
    windowDraws.count += 1;
    const [shown, setShown] = useState(live);
    showPage = setShown;
    return <AutomationsRunner {...props} live={shown} />;
  }
  const view = render(
    <Wrapper>
      <Window />
    </Wrapper>,
  );
  /** The index settles once more, having heard `heard` of the notes. */
  const indexNews = (heard: NoteChange[]) =>
    act(() => {
      reads.noteChanges(VAULT, heard);
      status.setState({ revision: status.getState().revision + 1 });
      reads.indexMoved(VAULT, true);
    });
  return {
    store,
    relay,
    changes,
    windowDraws,
    indexNews,
    view,
    show: (on: boolean) => act(() => showPage(on)),
  };
}

const added = (files: Record<string, string>, path: string) => ({
  vault: VAULT,
  changes: [{ kind: 'added' as const, path, type: 'task', digest: digestOf(files[path] ?? '') }],
});

const edited = (path: string): NoteChange => ({
  kind: 'changed',
  path,
  type: null,
  digest: 'b',
  before: 'a',
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the automations runner (#326)', () => {
  it('runs a rule a note sets off on the sync’s news of it, without drawing the window', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep'), [TASK]: '---\ntype: task\n---\n' });
    const { changes, windowDraws } = mountRunner(vault);
    await settle();
    const drawn = windowDraws.count;

    act(() => changes.publish(added(vault.files, TASK)));
    await settle();
    expect(vault.files[`Archive/Tasks/A.md`]).toBeDefined();
    expect(runsIn(vault.files[LOG]).map((entry) => entry.kind === 'run' && entry.trigger)).toEqual([
      'note',
    ]);
    expect(windowDraws.count).toBe(drawn);
  });

  it('runs nothing on the index’s news alone: no note nobody edited sets a rule off', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep'), [TASK]: '---\ntype: task\n---\n' });
    const { indexNews } = mountRunner(vault, true);
    await settle();

    await indexNews([edited(RULE), edited('Notes/Elsewhere.md')]);
    await settle();
    expect(vault.files[TASK]).toBeDefined();
    expect(runsIn(vault.files[LOG])).toEqual([]);
  });

  it('says where the rules stand in its store, and the API’s clock, once read', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep') });
    const { store, relay } = mountRunner(vault);
    await settle();
    const listing = store.getState().automations?.listing;
    expect(listing?.automations.map(({ rule: read }) => read.name)).toEqual(['Sweep']);
    expect(relay.clock.forVault(VAULT)).not.toBeNull();
  });

  it('reads the shown page’s rules again for news of the rules, and not of a note elsewhere', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep') });
    const { store, indexNews } = mountRunner(vault, true);
    await settle();
    const names = () =>
      store.getState().automations?.listing?.automations.map(({ rule: read }) => read.name);
    expect(names()).toEqual(['Sweep']);

    vault.files[RULE] = rule('Sweep renamed');
    await indexNews([edited('Notes/Elsewhere.md')]);
    await settle();
    expect(names()).toEqual(['Sweep']);

    await indexNews([edited(RULE)]);
    await settle();
    expect(names()).toEqual(['Sweep renamed']);
  });

  it('reads them again for the rules’ news only while the page is shown', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep') });
    const { store, indexNews, show } = mountRunner(vault, false);
    await settle();
    const names = () =>
      store.getState().automations?.listing?.automations.map(({ rule: read }) => read.name);

    vault.files[RULE] = rule('Sweep renamed');
    await indexNews([edited(RULE)]);
    await settle();
    expect(names()).toEqual(['Sweep']);

    // Shown, the page reads the rules afresh.
    await show(true);
    await settle();
    expect(names()).toEqual(['Sweep renamed']);
  });

  it('leaves its store empty once it is gone', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep') });
    const { store, view } = mountRunner(vault);
    await settle();
    expect(store.getState().automations).not.toBeNull();
    view.unmount();
    expect(store.getState().automations).toBeNull();
  });
});
