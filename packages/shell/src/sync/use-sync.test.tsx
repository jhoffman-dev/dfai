// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { withManagedIgnores } from '@dfai/domain';
import {
  failed,
  fakeSleepClock,
  fakeVaultFs,
  memorySyncFiles,
  OK,
  ProgramMissingError,
  recordingActivity,
  said,
  scriptedFolders,
  scriptedGit,
  statusText,
  type GitPort,
  type GitResult,
  type GitScript,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { drained, settles } from '@dfai/ui/testing/settles';
import { useSync, type SyncOptions } from './use-sync.ts';
import { syncConflictNotice, syncIndicatorBadge, syncSettingsView } from './sync-view.ts';
import { QUIT_SYNC_WAIT_MS, SYNC_TICK_MS } from './use-sync-schedule.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { toldNews } from '../reads/told-news.test-support.ts';

const NOT_A_REPO = failed('fatal: not a git repository', 128);
/** What a vault DFAI set up for sync says in its settings, beside its `.gitignore` block. */
const SET_UP = 'sync: github\nautomationsMac: mac-studio\nautomationsMacName: Studio';

/** Where the hand clock, and the fake timers' clock in the tests that use them, start. */
const START = Date.UTC(2026, 8, 28, 14, 5);

/** A clock the test moves by hand. */
function handClock(start = START) {
  let now = start;
  return {
    now: () => now,
    localNow: () => '2026-09-28T14:05:00',
    advance: (ms: number) => (now += ms),
  };
}

/** The vault's settings note and `.gitignore`, as the host's `readNotes` hands them back. */
function vaultFiles(
  frontmatter: string,
  { gitignore = withManagedIgnores(null) as string | null } = {},
) {
  return fakeVaultFs({
    readNotes: async (paths) => [
      ...(paths.includes('.atlas/settings.md')
        ? [{ path: '.atlas/settings.md', text: `---\n${frontmatter}\n---\n`, modified: 1, size: 1 }]
        : []),
      ...(paths.includes('.gitignore') && gitignore !== null
        ? [{ path: '.gitignore', text: gitignore, modified: 1, size: 1 }]
        : []),
    ],
  });
}

/**
 * A repository on GitHub and this Mac's clone of it, as far as a sync can
 * tell: edits to stage, commits to push, other Macs' commits to fetch and
 * merge, and a merge that may stop on a conflict.
 */
function modelGit() {
  const state = {
    edits: [] as string[],
    staged: [] as string[],
    ahead: 0,
    onGitHub: 0,
    fetched: 0,
    head: 1,
    conflictOnMerge: false,
    conflicted: false,
    merging: false,
  };
  const script: GitScript = {
    status: () =>
      said(
        statusText({
          changed: state.staged,
          ahead: state.ahead,
          behind: state.fetched,
          conflicts: state.conflicted ? [{ path: 'Ideas.md', code: 'UU' }] : [],
        }),
      ),
    addAll: () => {
      state.staged = [...state.staged, ...state.edits];
      state.edits = [];
      state.conflicted = false;
      return OK;
    },
    commit: () => {
      state.staged = [];
      state.merging = false;
      state.ahead += 1;
      return OK;
    },
    fetch: () => {
      state.fetched = state.onGitHub;
      return OK;
    },
    merge: () => {
      if (state.fetched === 0) return said('Already up to date.');
      state.fetched = 0;
      state.onGitHub = 0;
      state.head += 1;
      if (!state.conflictOnMerge) return OK;
      state.conflicted = true;
      state.merging = true;
      return failed('CONFLICT (content): Merge conflict in Ideas.md');
    },
    head: () => said(`h${state.head}\u0000100\n`),
    // Every file asked about is there, a copy a settle made among them.
    hashFile: () => said(`${'f'.repeat(40)}\n`),
    mergeInProgress: () => (state.merging ? said(`${'e'.repeat(40)}\n`) : failed('', 1)),
    push: () => {
      state.ahead = 0;
      return OK;
    },
  };
  return { state, script };
}

function setUpHook({
  script = {},
  parentTop,
  settings = SET_UP,
  mac = 'Studio',
  macId = 'mac-studio',
  gitOverrides = {},
  fs,
  paused = false,
  beforeFetch,
  sleep = fakeSleepClock(),
  edits = toldNews(),
  query = queryWrapper(),
  enabled = true,
}: {
  script?: GitScript;
  parentTop?: ReturnType<typeof said>;
  settings?: string;
  mac?: string;
  macId?: string;
  gitOverrides?: Partial<GitPort>;
  fs?: SyncOptions['fs'];
  paused?: boolean;
  /** Waited on before each fetch runs, so a test can hold one. */
  beforeFetch?: () => Promise<void>;
  /** The host's sleep counter (#172). */
  sleep?: ReturnType<typeof fakeSleepClock>;
  /** Where sync hears of an edit: the index's news, told by hand unless a test wires the real one. */
  edits?: { feed: SyncOptions['edits']; tell: () => void };
  query?: ReturnType<typeof queryWrapper>;
  /** Whether the platform syncs at all (#657). */
  enabled?: boolean;
} = {}) {
  // GitHub holds the settings this Mac has: a claim made here is shared (#630 attack).
  const onGitHub: GitScript = {
    remoteBranchExists: said(`${'f'.repeat(40)}\n`),
    remoteSettingsExist: OK,
    remoteSettings: said(`---\n${settings}\n---\n`),
  };
  const { git, called, calls } = scriptedGit({ script: { ...onGitHub, ...script } });
  const order: string[] = [];
  const closeTasks: (() => Promise<void>)[] = [];
  const activity = recordingActivity();
  const clock = handClock();
  const onPulled = vi.fn();
  const pauses = new Map<string, boolean>([['/Users/j/Notes', paused]]);
  const listRepositories = vi.fn(async (): Promise<GitResult> =>
    said(
      JSON.stringify([
        {
          name: 'notes',
          nameWithOwner: 'james/notes',
          defaultBranchRef: { name: 'main' },
          visibility: 'PRIVATE',
          url: 'https://github.com/james/notes',
        },
      ]),
    ),
  );
  const options: SyncOptions = {
    enabled,
    host: {
      git: () => ({
        ...git,
        commit: async (args) => {
          order.push('commit');
          return git.commit(args);
        },
        fetch: async () => {
          await beforeFetch?.();
          return git.fetch();
        },
        ...gitOverrides,
      }),
      files: () => memorySyncFiles().port,
      folders: scriptedFolders(parentTop === undefined ? {} : { topLevelOf: parentTop }),
      github: { listRepositories },
      thisMac: { name: async () => mac, id: async () => macId },
      pause: {
        read: (vault) => pauses.get(vault) ?? false,
        write: (vault, value) => void pauses.set(vault, value),
      },
      sleepClock: sleep.port,
    },
    fs: fs ?? vaultFiles(settings),
    markdown: remarkMarkdown,
    vaultKey: '/Users/j/Notes',
    edits: edits.feed,
    clock,
    activity,
    flushAll: async () => void order.push('flush'),
    closing: {
      beforeClose: async (task) => {
        closeTasks.push(task);
        return () => {};
      },
    },
    onPulled,
  };
  const hook = renderHook((props: SyncOptions) => useSync(props), {
    wrapper: query.wrapper,
    initialProps: options,
  });
  const { tell } = edits;
  return {
    hook,
    called,
    calls,
    order,
    closeTasks,
    clock,
    onPulled,
    options,
    pauses,
    listRepositories,
    tell,
  };
}

/** Moves the hand clock and the timers together, a tick at a time, as time passing would. */
async function wait(clock: ReturnType<typeof handClock>, ms: number) {
  for (let passed = 0; passed < ms; passed += SYNC_TICK_MS) {
    clock.advance(SYNC_TICK_MS);
    await act(async () => vi.advanceTimersByTime(SYNC_TICK_MS));
  }
}

afterEach(() => vi.useRealTimers());

describe('useSync', () => {
  it('takes a vault as one that does not sync, asking git nothing, where the platform has no sync (#657)', async () => {
    const model = modelGit();
    model.state.onGitHub = 1;
    const { hook, calls, order, onPulled } = setUpHook({ script: model.script, enabled: false });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    expect(hook.result.current.setup).toEqual({ kind: 'not-set-up' });
    // Nothing waits on a pull that will never come.
    expect(hook.result.current.syncedThisSession.has('/Users/j/Notes')).toBe(true);
    expect(calls).toEqual([]);
    expect(order).toEqual([]);
    expect(onPulled).not.toHaveBeenCalled();
  });

  it('pulls as a synced vault opens, writing unsaved typing before it commits', async () => {
    const model = modelGit();
    model.state.edits = ['Today.md'];
    model.state.onGitHub = 1;
    const { hook, order, onPulled } = setUpHook({ script: model.script });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(order).toEqual(['flush', 'commit']);
    expect(onPulled).toHaveBeenCalledOnce();
    expect(hook.result.current.setup).toMatchObject({ kind: 'set-up' });
    expect(syncIndicatorBadge(hook.result.current)).toEqual({ tone: 'ok', label: 'Synced' });
  });

  it('does nothing to a vault that does not sync, and offers to set it up', async () => {
    const { hook, called } = setUpHook({ script: { topLevel: NOT_A_REPO } });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    expect(called('fetch')).toHaveLength(0);
    expect(syncSettingsView(hook.result.current, 'Notes')).toMatchObject({
      stage: 'not-set-up',
      suggestedName: 'Notes',
    });
    expect(syncIndicatorBadge(hook.result.current)).toBeNull();
  });

  it('refuses a vault inside another repository, and never syncs it', async () => {
    const { hook, called } = setUpHook({
      script: { topLevel: said('/code\n') },
      parentTop: said('/code\n'),
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('refused'));
    expect(called('fetch')).toHaveLength(0);
    expect(syncSettingsView(hook.result.current, 'vault').problem).toContain(
      'inside another git repository',
    );
  });

  it('warns when both Macs changed a file', async () => {
    const model = modelGit();
    model.state.onGitHub = 1;
    model.state.conflictOnMerge = true;
    const { hook } = setUpHook({ script: model.script });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    const view = syncSettingsView(hook.result.current, 'Notes');
    expect(view.conflicts).toEqual([
      { path: 'Ideas.md', copy: 'Ideas (conflict from Laptop).md', whose: 'theirs' },
    ]);
    expect(view.tone).toBe('warning');
    expect(syncConflictNotice(hook.result.current.phase)).toContain('Both Macs changed Ideas.md');
  });

  it('says why a sync failed, and keeps the vault set up', async () => {
    const { hook } = setUpHook({
      script: { fetch: failed('fatal: Could not resolve host: github.com') },
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('failed'));
    const view = syncSettingsView(hook.result.current, 'Notes');
    expect(view.problem).toContain('couldn’t be reached');
    expect(view.stage).toBe('set-up');
    expect(view.statusLine).toContain('Last sync failed');
    expect(syncIndicatorBadge(hook.result.current)?.tone).toBe('error');
  });

  it('holds a vault switch until the sync under way has finished', async () => {
    let finishFetch: (result: ReturnType<typeof said>) => void = () => {};
    const { hook, options } = setUpHook({ script: { topLevel: NOT_A_REPO } });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    const slow = scriptedGit().git;
    hook.rerender({
      ...options,
      host: {
        ...options.host,
        git: () => ({
          ...slow,
          fetch: () => new Promise((resolve) => (finishFetch = resolve)),
        }),
      },
      vaultKey: '/Users/j/Other',
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('syncing'));
    let settled = false;
    const waiting = hook.result.current.settle().then(() => (settled = true));
    await act(async () => {});
    expect(settled).toBe(false);
    finishFetch(said(''));
    await waiting;
    expect(settled).toBe(true);
  });

  it('sets up sync and names this Mac, by its id, for the automations', async () => {
    const written: string[] = [];
    const { hook, options } = setUpHook({ script: { topLevel: [NOT_A_REPO] }, settings: '' });
    hook.rerender({
      ...options,
      fs: {
        ...options.fs,
        createNote: async ({ path, contents }) => {
          written.push(`${path}:${contents}`);
          return 0;
        },
        writeTextFile: async ({ path, contents }) => {
          written.push(`${path}:${contents}`);
          return 2;
        },
        readTextFile: async () => ({ text: '---\n---\n', modified: 1 }),
        listDirectory: async () => [],
      },
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    act(() => hook.result.current.setUp({ kind: 'new-github', name: 'notes' }));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(written.some((file) => file.startsWith('.gitignore:'))).toBe(true);
    const settings = written.filter((file) => file.startsWith('.atlas/settings.md:')).join('\n');
    expect(settings).toContain('sync: github');
    expect(settings).toContain('automationsMac: mac-studio');
    expect(settings).toContain('automationsMacName: Studio');
  });

  it('shows why setting up failed', async () => {
    const { hook } = setUpHook({ script: { topLevel: NOT_A_REPO } });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    act(() => hook.result.current.setUp({ kind: 'existing', url: 'not an address' }));
    await waitFor(() => expect(hook.result.current.problem).not.toBeNull());
    expect(hook.result.current.phase.kind).toBe('not-set-up');
  });
});

describe('useSync: sending and bringing in by itself (A29-01)', () => {
  it('sends a change about half a minute after it, and nothing without one', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    const { hook, called, clock, tell } = setUpHook({
      script: model.script,
      settings: `${SET_UP}\nsyncInterval: 60`,
    });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    await settles(() => expect(hook.result.current.settings?.pullIntervalMinutes).toBe(60));
    const pushes = called('push').length;
    await wait(clock, 25_000);
    expect(called('commit')).toHaveLength(0);
    model.state.edits = ['Today.md'];
    act(() => tell());
    await wait(clock, 25_000);
    expect(called('commit')).toHaveLength(0);
    await wait(clock, 10_000);
    await settles(() => expect(called('commit')).toHaveLength(1));
    expect(called('push').length).toBe(pushes + 1);
  });

  it('sends at least every five minutes while changes keep coming', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    const { hook, called, clock, tell } = setUpHook({
      script: model.script,
      settings: `${SET_UP}\nsyncInterval: 60`,
    });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    await settles(() => expect(hook.result.current.settings?.pullIntervalMinutes).toBe(60));
    // A change every 20 s from the first one: the half-minute quiet never comes.
    for (let second = 0; second < 300; second += 20) {
      model.state.edits = [`Log ${second}.md`];
      act(() => tell());
      await wait(clock, 20_000);
      if (second + 20 < 300) expect(called('commit'), `${second + 20} s in`).toHaveLength(0);
    }
    // Five minutes after the first change, still typing, it is sent.
    await settles(() => expect(called('commit')).toHaveLength(1));
  });

  it('looks at GitHub every minute, and brings changes in only when there are some', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    const { hook, called, clock, onPulled } = setUpHook({ script: model.script });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    const fetches = called('fetch').length;
    const merges = called('merge').length;
    await wait(clock, 60_000);
    await settles(() => expect(called('fetch').length).toBe(fetches + 1));
    // Nothing new on GitHub: a look, and no sync.
    expect(called('merge').length).toBe(merges);
    expect(called('addAll')).toHaveLength(1);
    model.state.onGitHub = 2;
    await wait(clock, 60_000);
    await settles(() => expect(called('merge').length).toBe(merges + 1));
    await settles(() => expect(onPulled).toHaveBeenCalledOnce());
    expect(hook.result.current.behind).toBe(0);
  });

  it('syncs at once when a look finds this Mac’s claim not on GitHub, and not while paused (#630 attack)', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    // The claim is here; GitHub, as the last fetch left it, still names the desk Mac.
    const desk = said(
      '---\nsync: github\nautomationsMac: mac-desk\nautomationsMacName: Desk\n---\n',
    );
    const { hook, called, clock, pauses } = setUpHook({
      script: { ...model.script, remoteSettings: desk },
    });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    const syncs = called('addAll').length;

    await wait(clock, 60_000);

    // The look, then the sync it asked for, which pushes the claim.
    await settles(() => expect(called('addAll').length).toBe(syncs + 1));
    expect(hook.result.current.claimPending).toEqual({ was: 'Desk' });

    pauses.set('/Users/j/Notes', true);
    const whilePaused = called('addAll').length;
    await wait(clock, 60_000);
    expect(called('addAll').length).toBe(whilePaused);
  });

  it('waits for typing to stop before bringing other Macs’ changes in, showing the vault behind', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    const { hook, called, clock, tell } = setUpHook({ script: model.script });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    const merges = called('merge').length;
    model.state.onGitHub = 1;
    // Typing: a change every 20 s, through the minute's look.
    for (let second = 20; second <= 80; second += 20) {
      model.state.edits = [`Draft ${second}.md`];
      act(() => tell());
      await wait(clock, 20_000);
    }
    await settles(() => expect(hook.result.current.behind).toBe(1));
    expect(called('merge').length).toBe(merges);
    expect(syncIndicatorBadge(hook.result.current)).toEqual({
      tone: 'behind',
      label: '1 change to bring in',
    });
    expect(syncSettingsView(hook.result.current, 'Notes').statusLine).toBe(
      '1 change from other Macs to bring in',
    );
    // Typing stops: the sync that sends it brings the other Mac's change in too.
    await wait(clock, 35_000);
    await settles(() => expect(called('merge').length).toBe(merges + 1));
    await settles(() => expect(hook.result.current.behind).toBe(0));
    expect(syncIndicatorBadge(hook.result.current)).toEqual({ tone: 'ok', label: 'Synced' });
  });

  it('runs nothing by itself while paused, and picks up again when resumed', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    const { hook, called, clock, tell, pauses } = setUpHook({
      script: model.script,
      paused: true,
    });
    await settles(() => expect(hook.result.current.setup?.kind).toBe('set-up'));
    expect(hook.result.current.paused).toBe(true);
    expect(syncIndicatorBadge(hook.result.current)).toEqual({
      tone: 'paused',
      label: 'Sync paused',
    });
    // Paused: not even as the vault opens.
    expect(called('fetch')).toHaveLength(0);
    model.state.edits = ['Today.md'];
    act(() => tell());
    await wait(clock, 120_000);
    expect(called('fetch')).toHaveLength(0);
    expect(called('commit')).toHaveLength(0);
    act(() => hook.result.current.setPaused(false));
    expect(pauses.get('/Users/j/Notes')).toBe(false);
    await wait(clock, 10_000);
    await settles(() => expect(called('commit')).toHaveLength(1));
  });

  it('runs a sync asked for during a look at GitHub once the look ends, never beside it', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    let hold: Promise<void> | null = null;
    let release: () => void = () => {};
    const { hook, called, clock } = setUpHook({
      script: model.script,
      beforeFetch: () => hold ?? Promise.resolve(),
    });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    const stages = called('addAll').length;
    hold = new Promise<void>((resolve) => (release = resolve));
    await wait(clock, 60_000);
    act(() => hook.result.current.syncNow());
    await act(async () => {});
    // The look is still waiting on GitHub: the sync has not started beside it.
    expect(called('addAll')).toHaveLength(stages);
    hold = null;
    release();
    await settles(() => expect(called('addAll')).toHaveLength(stages + 1));
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
  });

  it('still syncs when asked while paused', async () => {
    const model = modelGit();
    const { hook, called } = setUpHook({ script: model.script, paused: true });
    await waitFor(() => expect(hook.result.current.setup?.kind).toBe('set-up'));
    act(() => hook.result.current.syncNow());
    await waitFor(() => expect(called('fetch')).toHaveLength(1));
  });

  it('syncs once more as the window closes, but lets it close when that hangs', async () => {
    vi.useFakeTimers({ now: START });
    const { hook, called, closeTasks, options } = setUpHook({ script: modelGit().script });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(closeTasks).toHaveLength(1);
    await act(async () => {
      await closeTasks[0]?.();
    });
    expect(called('fetch')).toHaveLength(2);
    hook.rerender({ ...options, flushAll: () => new Promise<void>(() => {}) });
    let closed = false;
    const closing = closeTasks
      .at(-1)?.()
      .then(() => (closed = true));
    await act(async () => vi.advanceTimersByTime(QUIT_SYNC_WAIT_MS - 1));
    expect(closed).toBe(false);
    await act(async () => vi.advanceTimersByTime(1));
    await closing;
    expect(closed).toBe(true);
  });

  it('saves the intervals the person picks', async () => {
    const written: string[] = [];
    const { hook, options } = setUpHook({ script: modelGit().script });
    hook.rerender({
      ...options,
      fs: {
        ...options.fs,
        writeTextFile: async ({ contents }) => {
          written.push(contents);
          return 2;
        },
        readTextFile: async () => ({ text: `---\n${SET_UP}\n---\n`, modified: 1 }),
        listDirectory: async () => [],
      },
    });
    await waitFor(() => expect(hook.result.current.settings).not.toBeNull());
    act(() => hook.result.current.setPushDelay(120));
    await waitFor(() => expect(written.at(-1)).toContain('syncPushDelay: 120'));
    act(() => hook.result.current.setPullInterval(5));
    await waitFor(() => expect(written.at(-1)).toContain('syncInterval: 5'));
  });

  it('leaves who runs the automations as the file has it when the timing is saved (#630 review)', async () => {
    // The note as read when the vault opened names Studio; a pull since brought the desk Mac's claim.
    let onDisk = `---\n${SET_UP}\n---\n`;
    const { hook, options } = setUpHook({ script: modelGit().script });
    hook.rerender({
      ...options,
      fs: {
        ...options.fs,
        writeTextFile: async ({ contents }) => {
          onDisk = contents;
          return 2;
        },
        readTextFile: async () => ({ text: onDisk, modified: 1 }),
        listDirectory: async () => [],
      },
    });
    await waitFor(() => expect(hook.result.current.settings?.automationsMac).toBe('mac-studio'));
    onDisk = '---\nsync: github\nautomationsMac: mac-desk\nautomationsMacName: Desk\n---\n';

    act(() => hook.result.current.setPullInterval(15));

    await waitFor(() => expect(onDisk).toContain('syncInterval: 15'));
    expect(onDisk).toContain('automationsMac: mac-desk');
    expect(onDisk).toContain('automationsMacName: Desk');
  });

  it('shows on the card why a Settings → Sync claim named no Mac, busy while it waited (#630 review)', async () => {
    const { hook, options } = setUpHook({ script: modelGit().script, macId: 'mac-laptop' });
    let refuse: () => void = () => undefined;
    const refused = new Promise<void>((resolve) => (refuse = resolve));
    hook.rerender({
      ...options,
      fs: {
        ...options.fs,
        readTextFile: async () => ({ text: `---\n${SET_UP}\n---\n`, modified: 1 }),
        writeTextFile: async () => {
          await refused;
          throw new Error('the disk is full');
        },
        listDirectory: async () => [],
      },
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    await waitFor(() => expect(hook.result.current.settings).not.toBeNull());

    act(() => hook.result.current.claimAutomations());
    await waitFor(() => expect(syncSettingsView(hook.result.current, 'Notes').claiming).toBe(true));
    refuse();

    await waitFor(() =>
      expect(syncSettingsView(hook.result.current, 'Notes').problem).toMatch(
        /could not be named.*the disk is full$/,
      ),
    );
    expect(syncSettingsView(hook.result.current, 'Notes').claiming).toBe(false);
  });

  it('lists the person’s GitHub repositories for the picker, and says why it cannot', async () => {
    const { hook, listRepositories } = setUpHook({ script: { topLevel: NOT_A_REPO } });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    expect(hook.result.current.repositories.kind).toBe('idle');
    act(() => hook.result.current.loadRepositories());
    await waitFor(() => expect(hook.result.current.repositories.kind).toBe('ready'));
    expect(hook.result.current.repositories).toMatchObject({
      repositories: [{ nameWithOwner: 'james/notes', defaultBranch: 'main', isPrivate: true }],
    });
    listRepositories.mockResolvedValueOnce(
      failed('To get started with GitHub CLI, please run:  gh auth login'),
    );
    act(() => hook.result.current.loadRepositories());
    await waitFor(() => expect(hook.result.current.repositories.kind).toBe('failed'));
    expect(hook.result.current.repositories).toMatchObject({
      problem: expect.stringContaining('gh auth login'),
    });
  });
});

describe('useSync, after the A29-01 review', () => {
  /** A vault's files for setting up: the settings note, and anything written. */
  function writableVault(frontmatter = '') {
    const written: string[] = [];
    const fs: SyncOptions['fs'] = {
      ...vaultFiles(frontmatter),
      createNote: async ({ path, contents }) => {
        written.push(`${path}:${contents}`);
        return 0;
      },
      writeTextFile: async ({ path, contents }) => {
        written.push(`${path}:${contents}`);
        return 2;
      },
      readTextFile: async () => ({ text: '---\n---\n', modified: 1 }),
      listDirectory: async () => [],
    };
    return { fs, written };
  }

  it('runs setting up as the one sync at a time: a vault switch waits for it, and no sync runs beside it', async () => {
    let finish: (result: GitResult) => void = () => {};
    let creating = false;
    const { fs } = writableVault();
    const { hook, called } = setUpHook({
      script: { topLevel: [NOT_A_REPO] },
      settings: '',
      fs,
      gitOverrides: {
        createGitHubRepository: () => {
          creating = true;
          return new Promise((resolve) => (finish = resolve));
        },
      },
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    act(() => hook.result.current.setUp({ kind: 'new-github', name: 'notes' }));
    await waitFor(() => expect(creating).toBe(true));
    let settled = false;
    const waiting = hook.result.current.settle().then(() => (settled = true));
    act(() => hook.result.current.syncNow());
    await act(async () => {});
    expect(settled).toBe(false);
    expect(called('fetch')).toHaveLength(0);
    finish(said(''));
    await waiting;
    expect(settled).toBe(true);
  });

  it('does not sync, commit or push a repository DFAI never set up, even with an origin', async () => {
    // A vault kept with obsidian-git: its own repository, an origin, no DFAI marker.
    const { hook, called } = setUpHook({
      fs: vaultFiles('theme: dark', { gitignore: '.obsidian/workspace.json\n' }),
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    await act(async () => {});
    expect(called('commit')).toHaveLength(0);
    expect(called('fetch')).toHaveLength(0);
    expect(called('push')).toHaveLength(0);
  });

  it('takes a vault for set up only with both of DFAI’s marks', async () => {
    const onlySettings = setUpHook({ fs: vaultFiles(SET_UP, { gitignore: null }) });
    const onlyIgnores = setUpHook({ fs: vaultFiles('theme: dark') });
    const both = setUpHook({ fs: vaultFiles(SET_UP) });
    await waitFor(() => expect(both.hook.result.current.setup?.kind).toBe('set-up'));
    await waitFor(() => expect(onlySettings.hook.result.current.setup?.kind).toBe('not-set-up'));
    await waitFor(() => expect(onlyIgnores.hook.result.current.setup?.kind).toBe('not-set-up'));
  });

  it('runs no scheduled automations until the settings have been read', async () => {
    const neverRead = fakeVaultFs({ readNotes: () => new Promise(() => {}) });
    const { hook } = setUpHook({ fs: neverRead, script: { topLevel: NOT_A_REPO } });
    await waitFor(() => expect(hook.result.current.thisMac).not.toBeNull());
    expect(hook.result.current.automationsHere).toBe(false);
  });

  it('names the Mac for automations by an id of its own, so a renamed Mac keeps them', async () => {
    const renamed = setUpHook({
      settings: 'automationsMac: mac-studio\nautomationsMacName: Studio',
      mac: 'Studio (2)',
      macId: 'mac-studio',
      script: { topLevel: NOT_A_REPO },
    });
    const other = setUpHook({
      settings: 'automationsMac: mac-studio\nautomationsMacName: Studio',
      mac: 'Studio',
      macId: 'mac-laptop',
      script: { topLevel: NOT_A_REPO },
    });
    await waitFor(() => expect(renamed.hook.result.current.settings).not.toBeNull());
    await waitFor(() => expect(other.hook.result.current.settings).not.toBeNull());
    await waitFor(() => expect(renamed.hook.result.current.automationsHere).toBe(true));
    expect(other.hook.result.current.automationsHere).toBe(false);
    expect(syncSettingsView(other.hook.result.current, 'Notes').automationsMac).toBe('Studio');
  });
});

describe('useSync, after the second A29-01 review', () => {
  // [M3] A sync that committed and then could not reach GitHub left its
  // commits unsent until the next edit: a look found nothing behind.
  it('sends what a failed sync left unsent at the next look, with no new edit', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    model.state.edits = ['Today.md'];
    let offline = true;
    const script: GitScript = {
      ...model.script,
      fetch: () => {
        if (offline) return failed('fatal: unable to access: Could not resolve host: github.com');
        model.state.fetched = model.state.onGitHub;
        return OK;
      },
    };
    const { hook, called, clock } = setUpHook({ script });
    await settles(() => expect(hook.result.current.phase.kind).toBe('failed'));
    expect(model.state.ahead).toBe(1);
    offline = false;
    await wait(clock, 60_000);
    await settles(() => expect(called('push')).toHaveLength(1));
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(model.state.ahead).toBe(0);
  });

  // [L1] A tick between a vault switch's wait and the switch itself started
  // a sync on the vault being left, whose host calls were then refused.
  it('starts nothing on the vault being left once a switch has waited for it', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    const { hook, called, clock, tell } = setUpHook({ script: model.script });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    model.state.edits = ['Today.md'];
    act(() => tell());
    const fetches = called('fetch').length;
    await act(async () => hook.result.current.settle());
    act(() => hook.result.current.syncNow());
    await act(async () => {});
    expect(called('fetch')).toHaveLength(fetches);
    expect(called('commit')).toHaveLength(0);
    // A switch that never happens — the same vault chosen again — does not
    // stop sync for good: the vault's change is sent once the moment passes.
    await wait(clock, 35_000);
    await settles(() => expect(called('commit')).toHaveLength(1));
  });

  // [L8] The last vault's set-up error showed on the next.
  it('forgets why setting up failed once another vault opens', async () => {
    const { hook, options } = setUpHook({ script: { topLevel: NOT_A_REPO } });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    act(() => hook.result.current.setUp({ kind: 'existing', url: 'not an address' }));
    await waitFor(() => expect(hook.result.current.problem).not.toBeNull());
    hook.rerender({ ...options, vaultKey: '/Users/j/Other' });
    await waitFor(() => expect(hook.result.current.problem).toBeNull());
  });

  // [L3] The window's notice said this Mac's version was kept when a name
  // that differed only in case had put this Mac's file in the copy.
  it('says in the window’s notice when this Mac’s file went to the copy', () => {
    const phase = {
      kind: 'synced' as const,
      report: {
        at: 0,
        committed: true,
        pulled: true,
        pushed: true,
        conflicts: [
          { path: 'idea.md', copy: 'idea (conflict from Laptop).md', whose: 'ours' as const },
        ],
        notSynced: [],
        ignored: [],
      },
    };
    const notice = syncConflictNotice(phase) ?? '';
    expect(notice).not.toContain('This Mac’s version was kept');
    expect(notice).toContain('idea (conflict from Laptop).md');
  });
});

describe('useSync: what the session has synced (ADR-0034)', () => {
  it('names a vault once a sync of it has pulled from GitHub, and not before', async () => {
    let finishFetch: (result: GitResult) => void = () => {};
    const { hook } = setUpHook({
      gitOverrides: { fetch: () => new Promise((resolve) => (finishFetch = resolve)) },
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('syncing'));
    expect(hook.result.current.syncedThisSession.has('/Users/j/Notes')).toBe(false);

    finishFetch(OK);
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect([...hook.result.current.syncedThisSession]).toEqual(['/Users/j/Notes']);
  });

  it('counts each sync of a vault that brought files in, and none that brought nothing', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    model.state.onGitHub = 1;
    const { hook, called, clock } = setUpHook({ script: model.script });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect([...hook.result.current.syncPulls]).toEqual([['/Users/j/Notes', 1]]);

    // A sync that finds nothing new on GitHub brings nothing in.
    act(() => hook.result.current.syncNow());
    await settles(() => expect(called('fetch').length).toBeGreaterThan(1));
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(hook.result.current.syncPulls.get('/Users/j/Notes')).toBe(1);

    model.state.onGitHub = 2;
    await wait(clock, 60_000);
    await settles(() => expect(hook.result.current.syncPulls.get('/Users/j/Notes')).toBe(2));
  });

  it('does not name a vault whose sync failed', async () => {
    const { hook } = setUpHook({
      script: { fetch: failed('fatal: Could not resolve host: github.com') },
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('failed'));
    expect(hook.result.current.syncedThisSession.size).toBe(0);
  });

  it('does not name a synced vault paused on this Mac until a sync runs', async () => {
    const { hook } = setUpHook({ paused: true });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('ready'));
    expect(hook.result.current.syncedThisSession.size).toBe(0);

    act(() => hook.result.current.syncNow());
    await waitFor(() =>
      expect(hook.result.current.syncedThisSession.has('/Users/j/Notes')).toBe(true),
    );
  });

  it('names a vault that does not sync, or cannot, as soon as that is known', async () => {
    const notSetUp = setUpHook({ script: { topLevel: NOT_A_REPO } });
    await waitFor(() => expect(notSetUp.hook.result.current.phase.kind).toBe('not-set-up'));
    expect([...notSetUp.hook.result.current.syncedThisSession]).toEqual(['/Users/j/Notes']);

    const refused = setUpHook({
      script: { topLevel: said('/code\n') },
      parentTop: said('/code\n'),
    });
    await waitFor(() => expect(refused.hook.result.current.phase.kind).toBe('refused'));
    expect([...refused.hook.result.current.syncedThisSession]).toEqual(['/Users/j/Notes']);
  });
});

describe('useSync: acting only on what a fresh pull brought (ADR-0035 part 4)', () => {
  const VAULT = '/Users/j/Notes';
  /** Whether this Mac may run the import or a Claude step on the open vault's files now. */
  const acts = (hook: ReturnType<typeof setUpHook>['hook']) =>
    hook.result.current.pulledFiles.acts(VAULT);

  /** A vault's settings whose text the test can change, as a pull would. */
  function settingsFile(frontmatter: string) {
    const settings = { frontmatter };
    const fs = fakeVaultFs({
      readNotes: async (paths) =>
        paths
          .filter((path) => path === '.atlas/settings.md' || path === '.gitignore')
          .map((path) => ({
            path,
            text:
              path === '.gitignore'
                ? (withManagedIgnores(null) as string)
                : `---\n${settings.frontmatter}\n---\n`,
            modified: 1,
            size: 1,
          })),
    });
    return { settings, fs };
  }

  /** A fetch the test holds until it lets it go. */
  function heldFetch() {
    let release: () => void = () => {};
    let held: Promise<void> | null = new Promise<void>((resolve) => (release = resolve));
    return {
      beforeFetch: () => held ?? Promise.resolve(),
      release: () => {
        held = null;
        release();
      },
    };
  }

  afterEach(() => vi.restoreAllMocks());

  it('acts on nothing before the first pull of the session completes, and on the files once it has', async () => {
    const fetch = heldFetch();
    const { hook } = setUpHook({ script: modelGit().script, beforeFetch: fetch.beforeFetch });
    expect(await acts(hook)).toBe(false);
    await waitFor(() =>
      expect(hook.result.current.pulledFiles.standing).toEqual({ kind: 'pulling' }),
    );
    expect(await acts(hook)).toBe(false);
    fetch.release();
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(hook.result.current.pulledFiles.standing).toMatchObject({
      kind: 'pulled',
      startedAsleepMs: 457_335_000,
      namedAfter: true,
    });
    expect(await acts(hook)).toBe(true);
  });

  it('acts on nothing once the Mac has slept since that pull, until a pull started after the wake completes', async () => {
    const sleep = fakeSleepClock();
    const { hook } = setUpHook({ script: modelGit().script, sleep });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(await acts(hook)).toBe(true);
    sleep.sleep(20 * 60_000);
    expect(await acts(hook)).toBe(false);
    act(() => hook.result.current.syncNow());
    await waitFor(async () => expect(await acts(hook)).toBe(true));
  });

  it('does not count a pull that started before a sleep and completed after it', async () => {
    const sleep = fakeSleepClock();
    const fetch = heldFetch();
    const { hook } = setUpHook({
      script: modelGit().script,
      sleep,
      beforeFetch: fetch.beforeFetch,
    });
    await waitFor(() =>
      expect(hook.result.current.pulledFiles.standing).toEqual({ kind: 'pulling' }),
    );
    sleep.sleep(60_000);
    fetch.release();
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(await acts(hook)).toBe(false);
  });

  it('runs nothing when the settings the pull brought name another Mac, though the settings held still name this one', async () => {
    const { settings, fs } = settingsFile(SET_UP);
    const fetch = heldFetch();
    const { hook } = setUpHook({ script: modelGit().script, fs, beforeFetch: fetch.beforeFetch });
    await waitFor(() => expect(hook.result.current.automationsHere).toBe(true));
    // Another Mac claimed the automations: the pull brings its settings in.
    settings.frontmatter = 'sync: github\nautomationsMac: mac-laptop\nautomationsMacName: Laptop';
    fetch.release();
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(hook.result.current.automationsHere).toBe(true);
    expect(hook.result.current.pulledFiles.standing).toMatchObject({ namedAfter: false });
    expect(await acts(hook)).toBe(false);
  });

  it('runs nothing when the settings cannot be read after the pull, and says so in Activity', async () => {
    const { settings, fs } = settingsFile(SET_UP);
    const fetch = heldFetch();
    const { hook, options } = setUpHook({
      script: modelGit().script,
      fs,
      beforeFetch: fetch.beforeFetch,
    });
    await waitFor(() => expect(hook.result.current.automationsHere).toBe(true));
    settings.frontmatter = 'automationsMac: [mac-studio';
    fetch.release();
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(hook.result.current.pulledFiles.standing).toEqual({ kind: 'settings-unreadable' });
    expect(await acts(hook)).toBe(false);
    const reports = (options.activity as ReturnType<typeof recordingActivity>).reports;
    expect(reports.map((report) => report.message)).toContainEqual(
      expect.stringMatching(/settings \(\.atlas\/settings\.md\) cannot be read, so nothing runs/),
    );
  });

  it('runs nothing while sync is paused on this Mac, and says automations wait', async () => {
    const { hook, options, pauses } = setUpHook({ script: modelGit().script });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(await acts(hook)).toBe(true);
    act(() => hook.result.current.setPaused(true));
    expect(pauses.get(VAULT)).toBe(true);
    expect(await acts(hook)).toBe(false);
    const reports = (options.activity as ReturnType<typeof recordingActivity>).reports;
    expect(reports.map((report) => report.message)).toContainEqual(
      expect.stringMatching(/paused on this Mac, so automations wait/),
    );
    act(() => hook.result.current.setPaused(false));
    expect(await acts(hook)).toBe(true);
  });

  it('acts as before on a vault on a Mac without git: it cannot sync here', async () => {
    const { hook } = setUpHook({
      script: {
        topLevel: () => {
          throw new ProgramMissingError('git');
        },
      },
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('failed'));
    expect(hook.result.current.pulledFiles.standing).toEqual({ kind: 'not-synced' });
    expect(await acts(hook)).toBe(true);
  });

  it('acts on nothing while the counter cannot be read, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sleep = fakeSleepClock();
    const { hook } = setUpHook({ script: modelGit().script, sleep });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    sleep.unreadable();
    expect(await acts(hook)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      'How long this Mac has slept could not be read:',
      expect.any(Error),
    );
  });

  it('counts for nothing a pull whose start could not be placed against a sleep', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sleep = fakeSleepClock();
    sleep.unreadable();
    const { hook } = setUpHook({ script: modelGit().script, sleep });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    sleep.unreadable(false);
    expect(hook.result.current.pulledFiles.standing).toBeNull();
    expect(await acts(hook)).toBe(false);
  });

  it('acts as before on a vault that does not sync, and never reads the counter for it', async () => {
    const sleep = fakeSleepClock();
    sleep.unreadable();
    const { hook } = setUpHook({ script: { topLevel: NOT_A_REPO }, sleep });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    await waitFor(() => expect(hook.result.current.automationsHere).toBe(true));
    expect(await acts(hook)).toBe(true);
    expect(sleep.reads()).toBe(0);
  });

  it('acts on nothing after a sync fails, until one succeeds', async () => {
    const model = modelGit();
    const online = model.script.fetch as () => GitResult;
    let offline = false;
    const script: GitScript = {
      ...model.script,
      fetch: () => (offline ? failed('fatal: unable to access GitHub', 128) : online()),
    };
    const { hook } = setUpHook({ script });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(await acts(hook)).toBe(true);
    offline = true;
    act(() => hook.result.current.syncNow());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('failed'));
    // Not under way, and not known: it may have brought files in before it failed.
    expect(hook.result.current.pulledFiles.standing).toBeNull();
    expect(await acts(hook)).toBe(false);
    offline = false;
    act(() => hook.result.current.syncNow());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(await acts(hook)).toBe(true);
  });

  it('takes a look at GitHub that finds nothing new as a pull: after a wake, it reopens the gate with no sync', async () => {
    vi.useFakeTimers({ now: START });
    const sleep = fakeSleepClock();
    const model = modelGit();
    const { hook, called, clock } = setUpHook({ script: model.script, sleep });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    const merges = called('merge').length;
    sleep.sleep(20 * 60_000);
    expect(await acts(hook)).toBe(false);
    await wait(clock, 60_000);
    await drained();
    expect(await acts(hook)).toBe(true);
    expect(called('merge').length).toBe(merges);
  });

  it('keeps what it knew when a look at GitHub fails: the look changed no file', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    const online = model.script.fetch as () => GitResult;
    let offline = false;
    const script: GitScript = {
      ...model.script,
      fetch: () => (offline ? failed('fatal: unable to access GitHub', 128) : online()),
    };
    const { hook, clock } = setUpHook({ script });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(await acts(hook)).toBe(true);
    offline = true;
    await wait(clock, 60_000);
    await settles(() => expect(hook.result.current.phase.kind).toBe('failed'));
    expect(hook.result.current.pulledFiles.standing).toMatchObject({ kind: 'pulled' });
    expect(await acts(hook)).toBe(true);
  });

  it('acts on nothing once a look finds other Macs’ changes, until the sync brings them in', async () => {
    vi.useFakeTimers({ now: START });
    const model = modelGit();
    const { hook, called, clock, tell } = setUpHook({ script: model.script });
    await settles(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(await acts(hook)).toBe(true);
    const merges = called('merge').length;
    model.state.onGitHub = 1;
    // Typing holds the sync back past the minute's look.
    for (let second = 20; second <= 80; second += 20) {
      model.state.edits = [`Draft ${second}.md`];
      act(() => tell());
      await wait(clock, 20_000);
    }
    await settles(() => expect(hook.result.current.behind).toBe(1));
    expect(await acts(hook)).toBe(false);
    await wait(clock, 35_000);
    await settles(() => expect(called('merge').length).toBe(merges + 1));
    await drained();
    expect(await acts(hook)).toBe(true);
  });

  it('waits, once sync is set up on a vault, for its first sync or look to complete', async () => {
    // A repository DFAI has not set up: once set up, it reads as one that syncs.
    const { settings, fs } = settingsFile('automationsMac: mac-studio');
    let connected = false;
    const { hook } = setUpHook({
      script: {
        topLevel: said('/Users/j/Notes\n'),
        remoteUrl: () => (connected ? said('https://github.com/james/notes\n') : failed('', 2)),
      },
      fs,
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));
    expect(hook.result.current.pulledFiles.standing).toEqual({ kind: 'not-synced' });
    expect(await acts(hook)).toBe(true);
    act(() =>
      hook.result.current.setUp({ kind: 'existing', url: 'https://github.com/james/notes' }),
    );
    connected = true;
    settings.frontmatter = SET_UP;
    await waitFor(() => expect(hook.result.current.setup?.kind).toBe('set-up'));
    expect(hook.result.current.pulledFiles.standing).toBeNull();
    expect(await acts(hook)).toBe(false);
  });

  it('keeps a pull with its vault: the vault opened next waits for a pull of its own', async () => {
    const fetch = { held: null as Promise<void> | null, release: () => {} };
    const { hook, options } = setUpHook({
      script: modelGit().script,
      beforeFetch: () => fetch.held ?? Promise.resolve(),
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe('synced'));
    expect(await acts(hook)).toBe(true);
    fetch.held = new Promise<void>((resolve) => (fetch.release = resolve));
    const other = '/Users/j/Work';
    hook.rerender({ ...options, vaultKey: other });
    await waitFor(() => expect(hook.result.current.automationsHere).toBe(true));
    expect(await hook.result.current.pulledFiles.acts(other)).toBe(false);
    expect(await acts(hook)).toBe(false);
    fetch.held = null;
    fetch.release();
    await waitFor(async () => expect(await hook.result.current.pulledFiles.acts(other)).toBe(true));
  });
});
