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
  EVERY_ENTRY_POINT,
  createNoteChanges,
  fakeClaudeStepPorts,
  fakeIndexPort,
  fakeVaultFs,
  recordingActivity,
  type AutomationPorts,
  type EntryPointsOffered,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { createAutomationRelay } from '../api/automation-relay.ts';
import { AutomationsRunner, type AutomationsRunnerProps } from './automations-runner.tsx';
import { createAutomationsStore } from './automations-store.ts';
import { offeredFor } from '../features/offered-for.ts';
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
function mountRunner(
  vault: ReturnType<typeof memoryVault>,
  live = false,
  /** The Automations switch as the window first hands it (#901): on, the settings read. */
  switched: Switched = { enabled: true, featuresKnown: true },
) {
  const status = createIndexStatusStore();
  status.setState({ vault: VAULT, phase: 'ready', revision: 1 });
  const { client, wrapper: Wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const store = createAutomationsStore();
  const relay = createAutomationRelay();
  const changes = createNoteChanges({ onError: (cause) => void cause });
  const windowDraws = { count: 0 };
  let showPage: (shown: boolean) => void = () => {};
  let offerAnew: (offered: EntryPointsOffered) => void = () => {};
  let switchAnew: (next: Switched) => void = () => {};
  const props: Omit<AutomationsRunnerProps, 'live' | keyof Switched> = {
    offered: EVERY_ENTRY_POINT,
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
    const [offered, setOffered] = useState<EntryPointsOffered>(EVERY_ENTRY_POINT);
    const [switches, setSwitches] = useState(switched);
    showPage = setShown;
    offerAnew = setOffered;
    switchAnew = setSwitches;
    return <AutomationsRunner {...props} {...switches} offered={offered} live={shown} />;
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
    offer: (offered: EntryPointsOffered) => act(() => offerAnew(offered)),
    switchTo: (next: Switched) => act(() => switchAnew(next)),
  };
}

/** What the window hands the runner of the Automations switch (#901). */
type Switched = Pick<AutomationsRunnerProps, 'enabled' | 'featuresKnown'>;

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

  it.each([['reading'], ['kindle'], ['ask'], ['meetings'], ['graph'], ['slack']] as const)(
    'carries on, not starting over, when %s is switched off (#901)',
    async (feature) => {
      const vault = memoryVault({ [RULE]: rule('Sweep'), [TASK]: '---\ntype: task\n---\n' });
      const { store, relay, changes, offer } = mountRunner(vault);
      await settle();
      const listing = store.getState().automations?.listing;
      const watching = relay.clock.forVault(VAULT);
      expect(listing).toBeDefined();
      expect(watching).not.toBeNull();

      offer(offeredFor(EVERY_ENTRY_POINT, [feature]));
      await settle();
      expect(store.getState().automations?.listing).toBe(listing);
      // Watching since the same moment, with the same pauses: the runner was not made again.
      expect(relay.clock.forVault(VAULT)?.watchingSince).toBe(watching?.watchingSince);
      expect(relay.clock.forVault(VAULT)?.pauses).toBe(watching?.pauses);
      expect(runsIn(vault.files[LOG])).toEqual([]);

      // Still listening: a note it is told of sets its rule off as before.
      act(() => changes.publish(added(vault.files, TASK)));
      await settle();
      expect(vault.files['Archive/Tasks/A.md']).toBeDefined();
    },
  );

  it('leaves its store empty once it is gone', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep') });
    const { store, view } = mountRunner(vault);
    await settle();
    expect(store.getState().automations).not.toBeNull();
    view.unmount();
    expect(store.getState().automations).toBeNull();
  });
});

describe('the Automations switch (#901)', () => {
  const OFF_UNREAD: Switched = { enabled: false, featuresKnown: false };
  const OFF: Switched = { enabled: false, featuresKnown: true };
  const ON: Switched = { enabled: true, featuresKnown: true };
  const archived = (files: Record<string, string>) => files['Archive/Tasks/A.md'] !== undefined;

  it('sets off no rule for a vault whose settings switch it off, before the read answers or after', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep'), [TASK]: '---\ntype: task\n---\n' });
    const { changes, switchTo, store } = mountRunner(vault, false, OFF_UNREAD);
    await settle();
    act(() => changes.publish(added(vault.files, TASK)));
    await settle();
    expect(runsIn(vault.files[LOG])).toEqual([]);

    await switchTo(OFF);
    await settle();
    act(() => changes.publish(added(vault.files, TASK)));
    await settle();
    expect(runsIn(vault.files[LOG])).toEqual([]);
    expect(archived(vault.files)).toBe(false);
    // The rules are still read, for the undo of runs already made.
    expect(store.getState().automations?.listing?.automations).toHaveLength(1);
  });

  it('holds what a note set off while the settings are unread, and runs it once they say on', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep'), [TASK]: '---\ntype: task\n---\n' });
    const { changes, switchTo } = mountRunner(vault, false, OFF_UNREAD);
    await settle();
    act(() => changes.publish(added(vault.files, TASK)));
    await settle();
    expect(archived(vault.files)).toBe(false);

    await switchTo(ON);
    await settle();
    expect(archived(vault.files)).toBe(true);
    expect(runsIn(vault.files[LOG])).toHaveLength(1);
  });

  it('stops on switch-off, and starts again on switch-on without the app starting over', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep'), [TASK]: '---\ntype: task\n---\n' });
    const { changes, switchTo, relay } = mountRunner(vault);
    await settle();
    const watching = relay.clock.forVault(VAULT)?.watchingSince;
    await switchTo(OFF);
    await settle();
    act(() => changes.publish(added(vault.files, TASK)));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    await settle();
    expect(runsIn(vault.files[LOG])).toEqual([]);

    await switchTo(ON);
    await settle();
    act(() => changes.publish(added(vault.files, TASK)));
    await settle();
    expect(archived(vault.files)).toBe(true);
    expect(runsIn(vault.files[LOG])).toHaveLength(1);
    // The same runner throughout: switched on again, it did not start over.
    expect(relay.clock.forVault(VAULT)?.watchingSince).toBe(watching);
  });

  it('lets the news of a note changed while off go: switched on, it sets nothing off', async () => {
    const tidy = rule('Sweep').replace('when: a task is created', 'when: a task is changed');
    const vault = memoryVault({ [RULE]: tidy, [TASK]: '---\ntype: task\n---\n' });
    const { changes, switchTo } = mountRunner(vault);
    await settle();
    const changed = () => ({
      vault: VAULT,
      changes: [
        {
          kind: 'changed' as const,
          path: TASK,
          type: 'task',
          digest: digestOf(vault.files[TASK] ?? ''),
          before: 'a',
        },
      ],
    });

    await switchTo(OFF);
    await settle();
    vault.files[TASK] = '---\ntype: task\n---\n\nEdited while off.\n';
    act(() => changes.publish(changed()));
    await settle();
    await switchTo(ON);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    await settle();
    expect(archived(vault.files)).toBe(false);
    expect(runsIn(vault.files[LOG])).toEqual([]);

    // The control: the same news heard while on sets the rule off.
    vault.files[TASK] = '---\ntype: task\n---\n\nEdited while on.\n';
    act(() => changes.publish(changed()));
    await settle();
    expect(archived(vault.files)).toBe(true);
  });

  it('lets the run under way finish, its log written, and starts no rule after it', async () => {
    const files: Record<string, string> = {
      '.atlas/automations/A sweep.md': openRule('A sweep'),
      '.atlas/automations/B sweep.md': openRule('B sweep'),
      [TASK]: '---\ntype: task\n---\n',
      'Projects/B.md': '---\ntype: project\n---\n',
    };
    const vault = memoryVault(files);
    const held = holdFirstMove(vault);
    const { switchTo } = mountRunner(vault);
    await settle();
    // The first rule is mid-run, its move asked for and not yet done.
    expect(held.asked()).toBe(1);

    await switchTo(OFF);
    held.release();
    await settle();
    const logs = Object.keys(files).filter((path) => path.startsWith('.atlas/automations/log/'));
    expect(logs).toHaveLength(1);
    expect(runsIn(files[logs[0]!]).map((entry) => entry.kind)).toEqual(['run']);
    expect(files['Archive/Tasks/A.md']).toBeDefined();
    expect(files['Projects/B.md']).toBeDefined();
    expect(held.asked()).toBe(1);
  });

  it('runs the second rule too when nothing is switched off: the case above is not vacuous', async () => {
    const files: Record<string, string> = {
      '.atlas/automations/A sweep.md': openRule('A sweep'),
      '.atlas/automations/B sweep.md': openRule('B sweep'),
      [TASK]: '---\ntype: task\n---\n',
      'Projects/B.md': '---\ntype: project\n---\n',
    };
    const vault = memoryVault(files);
    const held = holdFirstMove(vault);
    mountRunner(vault);
    await settle();
    held.release();
    await settle();
    const logs = Object.keys(files).filter((path) => path.startsWith('.atlas/automations/log/'));
    expect(logs).toHaveLength(2);
    expect(files['Archive/Projects/B.md']).toBeDefined();
  });

  it('still undoes a run already made, with Automations off', async () => {
    const vault = memoryVault({ [RULE]: rule('Sweep'), [TASK]: '---\ntype: task\n---\n' });
    const { changes, switchTo, store } = mountRunner(vault);
    await settle();
    act(() => changes.publish(added(vault.files, TASK)));
    await settle();
    expect(archived(vault.files)).toBe(true);

    await switchTo(OFF);
    await settle();
    const automations = store.getState().automations;
    const loaded = automations?.listing?.automations[0];
    expect(loaded).toBeDefined();
    // The undo lists the vault's notes to find what the run archived.
    vault.ports.fs.listNotes = async () =>
      Object.keys(vault.files).map((path) => ({
        name: path.split('/').at(-1) ?? path,
        path: createVaultPath(path),
        modified: 1,
        size: vault.files[path]?.length ?? 0,
      }));
    await act(async () => {
      await automations?.undo(loaded!.rule);
    });
    await settle();
    expect(vault.files[TASK]).toBeDefined();
    expect(archived(vault.files)).toBe(false);
  });
});

/** A rule run as the vault opens, archiving one task of its own: `A sweep` takes A, `B sweep` B. */
function openRule(name: string): string {
  return [
    '---',
    'atlas: automation',
    `name: ${name}`,
    'enabled: true',
    'when: on app open',
    `which: FROM ${name.startsWith('A') ? 'task' : 'project'}`,
    'do: archive',
    '---',
    '',
  ].join('\n');
}

/** Holds the vault's first move until `release`, counting the moves asked for. */
function holdFirstMove(vault: ReturnType<typeof memoryVault>) {
  vault.ports.notePaths = Object.keys(vault.files).map((path) => createVaultPath(path));
  // Each rule asks after its own type alone: tasks live in Tasks/, projects in Projects/.
  Object.assign(vault.ports, {
    types: [...vault.ports.types, { ...vault.ports.types[0]!, name: 'project', label: 'Project' }],
  });
  vault.ports.index.query = async (_sql, parameters) => {
    const type = parameters.includes('project') ? 'project' : 'task';
    const folder = type === 'project' ? 'Projects/' : 'Tasks/';
    return {
      columns: ['path', 'title', 'type'],
      rows: Object.keys(vault.files)
        .filter((path) => path.startsWith(folder))
        .map((path) => [path, path, type]),
      truncated: false,
    };
  };
  const move = vault.ports.fs.moveEntry;
  let count = 0;
  let release: () => void = () => {};
  const first = new Promise<void>((resolve) => (release = resolve));
  vault.ports.fs.moveEntry = async (args) => {
    count += 1;
    if (count === 1) await first;
    return move(args);
  };
  return { release: () => release(), asked: () => count };
}
