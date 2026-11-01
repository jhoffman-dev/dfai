// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type VaultEntry, type VaultPath } from '@dfai/domain';
import {
  EVERY_ENTRY_POINT,
  VaultAccessError,
  memoryActivityStore,
  memoryIndexPort,
  fakeGoogleCalendar,
  fakeGranola,
  fakeSlack,
  failed,
  fakeSleepClock,
  memorySyncFiles,
  scriptedFolders,
  scriptedGit,
  type AppInfoPort,
  type GlobalCapturePort,
  type ModelProvider,
  type VaultFsPort,
  type VaultLocation,
  type VaultLocationStore,
  type VaultPickerPort,
  type WindowClosingPort,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { App, localToday } from './app.tsx';
import { preloadPages } from './pages-on-first-use.ts';
import type { VaultPorts } from './vault/use-vault.ts';
import type { NotePorts } from './notes/use-note.ts';
import type { IndexPorts } from './index/use-index.ts';
import type { ChatPorts } from './chat/use-chat.ts';
import type { LocalApiPorts } from './api/use-local-api.ts';
import type { SourcePorts } from './sources/source-ports.ts';
import { createBrowserGlobalCaptureStore } from './global-capture/browser-global-capture-store.ts';
import { startCountingRenders, stopCountingRenders } from '@dfai/ui/testing';

// Before React loads, so every commit is handed to the counter. It counts
// nothing until a test switches it on.
await vi.hoisted(async () => {
  const { installRenderCounter } = await import('@dfai/ui/testing');
  installRenderCounter();
});

const appInfo: AppInfoPort = { read: async () => ({ name: 'DFAI', version: '0.1.0' }) };

const location: VaultLocation = { absolutePath: '/Users/j/Vault', name: 'Vault' };

const entry = (path: string, kind: VaultEntry['kind']): VaultEntry =>
  ({ kind, name: path.split('/').at(-1) ?? '', path: createVaultPath(path) }) as VaultEntry;

/** A vault held in memory: directory listings by path, and file contents by path. */
function fakeVault({
  directories = {},
  files = {},
  remembered = null,
  picks = [],
  elsewhere = {},
}: {
  directories?: Record<string, VaultEntry[]>;
  files?: Record<string, string>;
  remembered?: VaultLocation | null;
  /** What the folder picker answers, in order, before it answers `location`. */
  picks?: VaultLocation[];
  /** Another vault's files, by its path: what reads and writes reach once it is the open one. */
  elsewhere?: Record<string, Record<string, string>>;
} = {}): VaultPorts & {
  picked: VaultPickerPort;
  written: Record<string, string>;
  /** Holds every read of a note until `release` is called: a host that takes its time. */
  holdReads: () => { release: () => void };
} {
  const written: Record<string, string> = {};
  // The host holds one open vault and refuses a write meant for another (R14-01).
  let open: string | null = remembered?.absolutePath ?? null;
  const filesOf = (): Record<string, string> =>
    open === null ? files : (elsewhere[open] ?? files);
  let holding: (() => void)[] | null = null;
  const holdReads = () => {
    holding = [];
    return {
      release: () => {
        const waiting = holding ?? [];
        holding = null;
        for (const go of waiting) go();
      },
    };
  };
  const fs: VaultFsPort = {
    listDirectory: async (path: VaultPath) => directories[path] ?? [],
    listFiles: async () => [],
    listNotes: async () =>
      Object.keys(files)
        .filter((name) => name.endsWith('.md'))
        .map((name) => ({
          name,
          path: createVaultPath(name),
          modified: 1,
          size: (files[name] ?? '').length,
        })),
    readNotes: async (paths: readonly string[]) =>
      paths.flatMap((path) =>
        files[path] === undefined
          ? []
          : [{ path, text: files[path], modified: 1, size: files[path].length }],
      ),
    readBinaryFile: async () => new ArrayBuffer(0),
    createFolder: async () => {},
    trashEntry: async () => {},
    writeBinaryFile: async () => 0,
    moveEntry: async ({ from, to }) => {
      files[to] = files[from] ?? '';
      delete files[from];
      directories[''] = (directories[''] ?? [])
        .filter((item) => item.path !== from)
        .concat(entry(to, 'file'));
    },
    createNote: async ({ path, contents }) => {
      if (files[path] !== undefined)
        throw new VaultAccessError('a note with that name already exists');
      files[path] = contents;
      directories[''] = [...(directories[''] ?? []), entry(path, 'file')];
      return 0;
    },
    readTextFile: async (path: VaultPath) => {
      if (holding !== null) await new Promise<void>((go) => holding?.push(go));
      const text = filesOf()[path];
      if (text === undefined) throw new VaultAccessError('no such entry');
      return { text, modified: 1 };
    },
    writeTextFile: async ({
      path,
      contents,
      vault,
    }: {
      path: VaultPath;
      contents: string;
      vault?: string;
    }) => {
      if (vault !== undefined && vault !== open) {
        throw new VaultAccessError(`${vault} is not the open vault`);
      }
      written[path] = contents;
      filesOf()[path] = contents;
      return 2;
    },
  };
  let held = remembered;
  const store: VaultLocationStore = {
    read: async () => held,
    write: async (next) => {
      held = next;
    },
  };
  const picker: VaultPickerPort = {
    pickDirectory: async () => {
      const picked = picks.shift() ?? location;
      open = picked.absolutePath;
      return picked;
    },
  };
  const watch = { start: async () => {}, onChange: async () => () => {} };
  return { fs, store, picker, watch, picked: picker, written, holdReads };
}

const notesFor = (vault: VaultPorts): NotePorts => ({
  fs: vault.fs,
  markdown: remarkMarkdown,
});

/** An index that answers plausibly without a database behind it. */
const fakeIndexPorts = (vault: VaultPorts): IndexPorts => ({
  fs: vault.fs,
  markdown: remarkMarkdown,
  index: {
    open: async () => ({ fresh: false }),
    clear: async () => {},
    manifest: async () => [],
    put: async () => {},
    remove: async () => {},
    search: async () => [],
    backlinks: async () => [],
    notesOfType: async () => [],
    rebuildViews: async () => {},
    query: async () => ({ columns: [], rows: [], truncated: false }),
    stats: async () => ({ notes: 0, properties: 0, links: 0 }),
  },
});

/** Google Calendar with no sign-in, as on a Mac that never connected. */
const googleCalendar = fakeGoogleCalendar().port;
/** Granola with no key held: nothing in these tests pulls. */
const granola = {
  port: { ...fakeGranola().port, status: async () => ({ hasKey: false, lastRefusal: null }) },
  records: { read: () => ({ watermark: null, lastPullAt: null }), write: () => {} },
};

/** Slack with no token kept: nothing in these tests pastes a Slack link. */
const slack = fakeSlack(() => ({ ok: true }), { hasToken: false });

/** Nothing in these tests fetches; a source that did would say so by throwing. */
const sources: SourcePorts = {
  http: {
    get: async () => {
      throw new Error('the app fetched something this test did not expect');
    },
  },
  sqlite: {
    query: () => Promise.reject(new Error('the app read a SQLite file this test did not expect')),
    pick: async () => null,
  },
  secrets: {
    list: async () => [],
    set: async () => {},
    bind: async () => {},
    remove: async () => {},
  },
};

/** The local API, off, with nothing arriving over it. */
const api: LocalApiPorts = {
  bridge: { serve: async () => () => {} },
  settings: {
    status: async () => ({ enabled: false, port: null, running: false, file: '/tmp/api.json' }),
    setEnabled: async () => {
      throw new Error('this test did not expect the API to be switched');
    },
    token: async () => 'token',
    rotateToken: async () => 'rotated',
  },
  clipboard: { write: async () => {} },
  mcpEntry: null,
};

/** Claude, reachable by neither way: these tests never open the chat. */
const unreachable: ModelProvider = {
  id: 'claude-code',
  status: async () => ({
    ready: false,
    problem: 'unavailable',
    message: 'Not in tests.',
    fix: null,
  }),
  stream: () => {
    throw new Error('this test did not expect to ask Claude anything');
  },
};
const chat: ChatPorts = { claudeCode: unreachable, anthropicApi: () => unreachable };

/** The Activity log kept in memory, and a window whose close button is never pressed. */
const activityIn = (store = memoryActivityStore()) => ({
  store,
  closing: { beforeClose: async () => () => undefined },
});

/** A vault in no repository, on a Mac with git: sync is simply not set up. */
const noSync = {
  git: () => scriptedGit({ script: { topLevel: failed('fatal: not a git repository', 128) } }).git,
  folders: scriptedFolders(),
  files: () => memorySyncFiles().port,
  github: { listRepositories: async () => ({ code: 0, stdout: '[]', stderr: '' }) },
  pause: { read: () => false, write: () => {} },
  thisMac: { name: async () => 'Test Mac', id: async () => 'mac-test' },
  sleepClock: fakeSleepClock().port,
};

/**
 * The host's global capture shortcut: whatever is asked for is registered,
 * and `press` delivers a press as the host's event would.
 */
function fakeGlobalCapture() {
  const pressed: (() => void)[] = [];
  const asked: (string | null)[] = [];
  const port: GlobalCapturePort = {
    status: async () => ({ shortcut: null, registered: false, problem: null }),
    set: async (shortcut) => {
      asked.push(shortcut);
      return { shortcut, registered: shortcut !== null, problem: null };
    },
    listen: async (handler) => {
      pressed.push(handler);
      return () => void pressed.splice(pressed.indexOf(handler), 1);
    },
  };
  return {
    ports: { port, store: createBrowserGlobalCaptureStore() },
    asked,
    // Not inside `act`: the host's event arrives outside React, and what it
    // does is waited for on the screen.
    press: () => {
      for (const handler of pressed) handler();
    },
  };
}

const renderApp = (
  vault: ReturnType<typeof fakeVault>,
  activity: ReturnType<typeof memoryActivityStore> = memoryActivityStore(),
  globalCapture = fakeGlobalCapture(),
) =>
  render(
    <App
      offered={EVERY_ENTRY_POINT}
      appInfo={appInfo}
      vault={vault}
      notes={notesFor(vault)}
      index={fakeIndexPorts(vault)}
      sources={sources}
      links={{ open: async () => {} }}
      snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
      api={api}
      chat={chat}
      activity={activityIn(activity)}
      sync={noSync}
      googleCalendar={googleCalendar}
      granola={granola}
      slack={slack}
      globalCapture={globalCapture.ports}
    />,
  );

// The shortcuts read the platform: jsdom's is none, and these tests press ⌘.
beforeAll(() => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'));

// The window now remembers its split per vault, in local storage, and every
// test here opens the same vault. Without this each test would inherit the
// panes the one before it left, which is an order dependence.
beforeEach(() => window.localStorage.clear());

// The pages loaded on first use, loaded before the tests as the app loads them after
// start-up: the first import of their chunks is slow enough under load to outlast a find.
beforeAll(() => preloadPages(), 30_000);

/** The rows of the list on Settings' left, by title. */
const listedSections = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('navigation', { name: 'Settings sections' }))
    .getAllByRole('button')
    .map((row) => row.textContent);

/** The sections drawn in Settings, by heading, in order. */
const drawnSections = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll('.settings__body h2.settings__heading')].map(
    (heading) => heading.textContent,
  );

describe('App', () => {
  it('offers to open a vault on a first run', async () => {
    renderApp(fakeVault());
    expect(await screen.findByRole('heading', { name: 'Open a vault' })).toBeDefined();
    // No vault, so no tree and nothing to index — only the way to open one.
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('opens Settings from the gear, with or without a vault, and closes it again', async () => {
    renderApp(fakeVault());
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));

    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(dialog).findByText('Off')).toBeDefined();
    expect(listedSections(dialog)).toEqual(drawnSections(dialog));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });

  it('opens Settings with Cmd+,', async () => {
    renderApp(fakeVault());
    await screen.findByRole('heading', { name: 'Open a vault' });

    await userEvent.keyboard('{Meta>},{/Meta}');

    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeDefined();
  });

  it('reopens the vault from last launch and lists it', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('Notes', 'directory'), entry('todo.md', 'file')] },
    });
    renderApp(vault);
    expect(await screen.findByText('Notes')).toBeDefined();
    expect(screen.getByRole('treeitem', { name: 'todo' })).toBeDefined();
  });

  it('opens a vault the user chooses', async () => {
    const vault = fakeVault({ directories: { '': [entry('todo.md', 'file')] } });
    renderApp(vault);
    await userEvent.click(await screen.findByRole('button', { name: 'Choose folder…' }));
    expect(await screen.findByRole('treeitem', { name: 'todo' })).toBeDefined();
  });

  it('reads a directory only when it is expanded', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('Notes', 'directory')], Notes: [entry('Notes/today.md', 'file')] },
    });
    const listDirectory = vi.spyOn(vault.fs, 'listDirectory');
    // Only reads of this folder count: the app also reads .atlas for types
    // and templates, which is not what this test is about.
    const readsOf = (path: string) =>
      listDirectory.mock.calls.filter(([argument]) => argument === path).length;
    renderApp(vault);

    await screen.findByText('Notes');
    expect(readsOf('Notes')).toBe(0);
    expect(screen.queryByRole('treeitem', { name: 'today' })).toBeNull();

    await userEvent.click(screen.getByText('Notes'));
    expect(await screen.findByRole('treeitem', { name: 'today' })).toBeDefined();
    expect(readsOf('Notes')).toBe(1);
  });

  it('collapses a directory again without re-reading it', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('Notes', 'directory')], Notes: [entry('Notes/today.md', 'file')] },
    });
    const listDirectory = vi.spyOn(vault.fs, 'listDirectory');
    const readsOf = (path: string) =>
      listDirectory.mock.calls.filter(([argument]) => argument === path).length;
    renderApp(vault);

    await userEvent.click(await screen.findByText('Notes'));
    await screen.findByRole('treeitem', { name: 'today' });
    await userEvent.click(screen.getByText('Notes'));
    expect(screen.queryByRole('treeitem', { name: 'today' })).toBeNull();

    await userEvent.click(screen.getByText('Notes'));
    await screen.findByRole('treeitem', { name: 'today' });
    expect(readsOf('Notes')).toBe(1);
  });

  it('stops reading the vault once it is listed, rather than reading it again on every render (#140)', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('todo.md', 'file')] },
    });
    const listDirectory = vi.spyOn(vault.fs, 'listDirectory');
    renderApp(vault);
    await screen.findByRole('treeitem', { name: 'todo' });

    /** How many listings the app asks for across a few turns of the event loop. */
    const readsOverAFewTurns = async () => {
      const before = listDirectory.mock.calls.length;
      await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
      return listDirectory.mock.calls.length - before;
    };
    // A read whose answer draws the app, which reads again, never gets to none.
    await waitFor(async () => expect(await readsOverAFewTurns()).toBe(0), { timeout: 4000 });
  });

  it('renders the note body in the editor, without its frontmatter', async () => {
    const text = '---\ntitle: Today\n---\n\n# Today\n\nSome body text.\n';
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('today.md', 'file')] },
      files: { 'today.md': text },
    });
    renderApp(vault);

    await userEvent.click(await screen.findByRole('treeitem', { name: 'today' }));

    // The body is edited; the frontmatter is held aside and written back untouched.
    const body = await screen.findByLabelText('Note');
    expect(await within(body).findByRole('heading', { name: 'Today', level: 1 })).toBeDefined();
    expect(await screen.findByText('Some body text.')).toBeDefined();
    expect(screen.queryByText('title: Today')).toBeNull();
  });

  it('shows the note as saved until something is edited', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('today.md', 'file')] },
      files: { 'today.md': '# Today\n' },
    });
    renderApp(vault);

    await userEvent.click(await screen.findByRole('treeitem', { name: 'today' }));
    expect(await screen.findByText('Saved', { exact: true })).toBeDefined();
    // Saving is a command in the page's menu now, and there is nothing to save.
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    const save = await screen.findByRole('menuitem', { name: /^Save now/ });
    expect(save.getAttribute('aria-disabled')).toBe('true');
  });

  it('reports a note it cannot read instead of showing an empty pane', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('photo.png', 'file')] },
    });
    renderApp(vault);

    await userEvent.click(await screen.findByText('photo.png'));
    expect((await screen.findByRole('alert')).textContent).toBe('no such entry');
  });

  it('reports a vault it cannot list', async () => {
    const vault = fakeVault({ remembered: location });
    vault.fs.listDirectory = () => Promise.reject(new VaultAccessError('permission denied'));
    renderApp(vault);
    expect((await screen.findByRole('alert')).textContent).toBe('permission denied');
  });

  it('shows the app version in Settings → About once the host answers', async () => {
    renderApp(fakeVault());
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const about = within(dialog).getByRole('region', { name: 'About' });
    expect(await within(about).findByText('DFAI 0.1.0')).toBeDefined();
  });
});

describe('wiki links', () => {
  const linked = () =>
    fakeVault({
      remembered: location,
      directories: { '': [entry('today.md', 'file'), entry('Another Note.md', 'file')] },
      files: {
        'today.md': 'see [[Another Note]] for more\n',
        'Another Note.md': '# Another Note\n\nThe target.\n',
      },
    });

  it('opens the note a link points at when it is clicked', async () => {
    renderApp(linked());
    await userEvent.click(await screen.findByRole('treeitem', { name: 'today' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Another Note' }));

    expect(await screen.findByRole('article', { name: 'Another Note' })).toBeDefined();
    expect(await screen.findByText('The target.')).toBeDefined();
  });

  it('says so when a link points nowhere', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('today.md', 'file')] },
      files: { 'today.md': 'see [[Missing Note]] for more\n' },
    });
    renderApp(vault);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'today' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Missing Note' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'No note called "Missing Note"',
    );
  });

  it('shows the alias rather than the target when one is given', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('today.md', 'file')] },
      files: { 'today.md': 'see [[Another Note|the other one]]\n' },
    });
    renderApp(vault);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'today' }));
    expect(await screen.findByRole('link', { name: 'the other one' })).toBeDefined();
  });
});

describe('two panes', () => {
  // jsdom lays nothing out, and ProseMirror measures the selection when the
  // focus lands back in an editor after a close.
  beforeAll(() => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  });

  const linked = () =>
    fakeVault({
      remembered: location,
      directories: { '': [entry('today.md', 'file'), entry('Another Note.md', 'file')] },
      files: {
        'today.md': 'see [[Another Note]] for more\n',
        'Another Note.md': '# Another Note\n\nThe target.\n',
      },
    });

  const pane = (which: 1 | 2) => screen.getByRole('region', { name: `Pane ${which}` });

  /** Opens today.md and splits the window, which is where each test starts. */
  async function splitOnToday(vault: ReturnType<typeof fakeVault>) {
    renderApp(vault);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'today' }));
    await screen.findByRole('article', { name: 'today' });
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Split right/ }));
    await screen.findByRole('region', { name: 'Pane 2' });
  }

  it('starts the new pane on the note the old one holds', async () => {
    await splitOnToday(linked());

    expect(within(pane(1)).getByRole('article', { name: 'today' })).toBeDefined();
    expect(within(pane(2)).getByRole('article', { name: 'today' })).toBeDefined();
  });

  it('opens a note from the sidebar in the pane being worked in', async () => {
    await splitOnToday(linked());

    await userEvent.click(screen.getByRole('treeitem', { name: 'Another Note' }));

    // The split moved the focus to the new pane, so that is where it landed.
    expect(await within(pane(2)).findByRole('article', { name: 'Another Note' })).toBeDefined();
    expect(within(pane(1)).getByRole('article', { name: 'today' })).toBeDefined();
  });

  it('lands in the other pane once that is the one clicked into', async () => {
    await splitOnToday(linked());
    await userEvent.click(within(pane(1)).getByRole('article', { name: 'today' }));

    await userEvent.click(screen.getByRole('treeitem', { name: 'Another Note' }));

    expect(await within(pane(1)).findByRole('article', { name: 'Another Note' })).toBeDefined();
    expect(within(pane(2)).getByRole('article', { name: 'today' })).toBeDefined();
  });

  it('follows a link in the pane it was clicked in, leaving the other one alone', async () => {
    await splitOnToday(linked());

    // A plain click peeks the note (slice 6b); expanding it follows the link in this pane.
    await userEvent.click(within(pane(1)).getByRole('link', { name: 'Another Note' }));
    const peek = await screen.findByRole('dialog', { name: 'Another Note' });
    await userEvent.click(within(peek).getByRole('button', { name: 'Open as full page' }));

    expect(await within(pane(1)).findByRole('article', { name: 'Another Note' })).toBeDefined();
    expect(within(pane(2)).getByRole('article', { name: 'today' })).toBeDefined();
  });

  it('closes a pane, leaving the note the other one held', async () => {
    await splitOnToday(linked());
    await userEvent.click(screen.getByRole('treeitem', { name: 'Another Note' }));
    await within(pane(2)).findByRole('article', { name: 'Another Note' });

    await userEvent.click(within(pane(2)).getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Close pane/ }));

    expect(screen.queryByRole('region', { name: 'Pane 2' })).toBeNull();
    expect(within(pane(1)).getByRole('article', { name: 'today' })).toBeDefined();
    // The menu went with the pane; the focus is not left on the body.
    expect(pane(1).contains(document.activeElement)).toBe(true);
  });

  it('marks only the note in the focused pane in the sidebar', async () => {
    await splitOnToday(linked());
    await userEvent.click(screen.getByRole('treeitem', { name: 'Another Note' }));
    await within(pane(2)).findByRole('article', { name: 'Another Note' });

    const marked = screen
      .getAllByRole('treeitem')
      .filter((row) => row.getAttribute('aria-selected') === 'true')
      .map((row) => row.getAttribute('aria-label'));
    expect(marked).toEqual(['Another Note']);
  });

  it('stars a note open in both panes through an editor, not underneath one', async () => {
    const vault = linked();
    await splitOnToday(vault);

    await userEvent.click(within(pane(1)).getByRole('button', { name: 'Add today to favorites' }));

    // Written through a pane's own save, so it keeps the body it was holding.
    expect(vault.written['today.md']).toContain('favorite: true');
    expect(vault.written['today.md']).toContain('[[Another Note]]');
    // Both panes still show the note, neither stuck on a stale read.
    expect(within(pane(1)).getByRole('article', { name: 'today' })).toBeDefined();
    expect(within(pane(2)).getByRole('article', { name: 'today' })).toBeDefined();
  });
});

describe('creating a note', () => {
  const vaultWith = () =>
    fakeVault({
      remembered: location,
      directories: { '': [entry('today.md', 'file')] },
      files: { 'today.md': '# Today\n' },
    });

  it('adds a note and opens it', async () => {
    const vault = vaultWith();
    renderApp(vault);

    await userEvent.click(await screen.findByRole('button', { name: 'New note' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Blank note' }));

    expect(await screen.findByRole('article', { name: 'Untitled' })).toBeDefined();
    expect(vault.written['Untitled.md'] ?? Object.keys(vault.fs)).toBeDefined();
  });

  it('names the new note once, at the top of its page, not again in a heading (U-09)', async () => {
    renderApp(vaultWith());

    await userEvent.click(await screen.findByRole('button', { name: 'New note' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Blank note' }));

    const article = await screen.findByRole('article', { name: 'Untitled' });
    expect(within(article).getByRole('button', { name: 'Untitled' })).toBeDefined();
    const body = await screen.findByLabelText('Note');
    expect(within(body).queryAllByRole('heading')).toEqual([]);
  });

  it('numbers the next one rather than refusing', async () => {
    renderApp(vaultWith());

    const button = await screen.findByRole('button', { name: 'New note' });
    await userEvent.click(button);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Blank note' }));
    await screen.findByRole('article', { name: 'Untitled' });

    await userEvent.click(button);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Blank note' }));

    expect(await screen.findByRole('article', { name: 'Untitled 2' })).toBeDefined();
  });

  it('keeps no error line for the name it tried first and found taken (A28-01)', async () => {
    const activity = memoryActivityStore();
    const files: Record<string, string> = { 'today.md': '# Today\n' };
    renderApp(
      fakeVault({
        remembered: location,
        directories: { '': [entry('today.md', 'file')] },
        files,
      }),
      activity,
    );
    const button = await screen.findByRole('button', { name: 'New note' });
    // Made on disk by something else, and not yet seen: the first name tried is refused.
    files['Untitled.md'] = '# Untitled\n';
    await userEvent.click(button);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Blank note' }));
    await screen.findByRole('article', { name: 'Untitled 2' });

    // What waits is written at once as the page unloads, so a line would be in the file now.
    window.dispatchEvent(new Event('beforeunload'));
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(activity.files.get(location.absolutePath) ?? '').not.toContain('"level":"error"');
  });

  it("puts today's note in its year's Daily folder, whatever note is in view", async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('Notes', 'directory')], Notes: [entry('Notes/a.md', 'file')] },
      files: { 'Notes/a.md': '# A\n' },
    });
    const createNote = vi.spyOn(vault.fs, 'createNote');
    renderApp(vault);

    await userEvent.click(await screen.findByText('Notes'));
    await userEvent.click(await screen.findByRole('treeitem', { name: 'a' }));
    await screen.findByRole('article', { name: 'a' });
    await userEvent.click(await screen.findByRole('button', { name: 'New note' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: "Today's note" }));

    expect(await screen.findByRole('article', { name: localToday() })).toBeDefined();
    expect(createNote.mock.calls.map(([args]) => args.path)).toEqual([
      `Daily/${localToday().slice(0, 4)}/${localToday()}.md`,
    ]);
  });
});

describe('the palettes and the shortcuts around them', () => {
  const vaultWith = () =>
    fakeVault({
      remembered: location,
      directories: { '': [entry('recipes.md', 'file')] },
      files: { 'recipes.md': '# Recipes\n\nSourdough.\n' },
    });

  const searchPalette = () => screen.queryByRole('dialog', { name: 'Search notes' });

  it('finds a note from Cmd+K, opens it, and puts the palette away', async () => {
    const vault = vaultWith();
    const index = fakeIndexPorts(vault);
    index.index.search = async () => [
      { path: 'recipes.md', title: 'Recipes', snippet: '<<Sourdough>>' },
    ];
    render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={vault}
        notes={notesFor(vault)}
        index={index}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={activityIn()}
        sync={noSync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.click(await screen.findByLabelText('Search the vault'));
    await userEvent.paste('sour');
    await userEvent.click(await screen.findByRole('option', { name: /Recipes/ }));

    expect(await screen.findByRole('article', { name: 'recipes' })).toBeDefined();
    expect(searchPalette()).toBeNull();
  });

  it('closes the search palette with Escape, opening nothing', async () => {
    renderApp(vaultWith());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search notes' })).toBeDefined();
    await userEvent.keyboard('{Escape}');

    expect(searchPalette()).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('makes a captured line a note of its own in the Inbox, and opens it (Shift+Cmd+N)', async () => {
    const vault = vaultWith();
    const createNote = vi.spyOn(vault.fs, 'createNote');
    renderApp(vault);
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}{Shift>}n{/Shift}{/Meta}');
    await userEvent.type(await screen.findByLabelText('What needs doing'), 'Buy flour{Enter}');

    // Capture stays up for the next line; the note opens behind it.
    await vi.waitFor(() =>
      expect(createNote.mock.calls.map(([args]) => args.path)).toEqual(['Inbox/Buy flour.md']),
    );
    expect(screen.getByRole('dialog', { name: 'Capture a task' })).toBeDefined();
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('article', { name: 'Buy flour' })).toBeDefined();
  });

  it('opens quick capture when the global shortcut is pressed in another app, and captures into the Inbox (#81)', async () => {
    const vault = vaultWith();
    const createNote = vi.spyOn(vault.fs, 'createNote');
    const capture = fakeGlobalCapture();
    renderApp(vault, memoryActivityStore(), capture);
    await screen.findByRole('treeitem', { name: 'recipes' });
    // Handed to the host as the app starts: the default, ⌃⌥N, on a Mac that chose nothing.
    await vi.waitFor(() => expect(capture.asked).toEqual(['Control+Alt+KeyN']));
    expect(screen.queryByRole('dialog', { name: 'Capture a task' })).toBeNull();

    capture.press();

    const field = await screen.findByLabelText('What needs doing');
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.type(field, 'Call the plumber{Enter}');
    await vi.waitFor(() =>
      expect(createNote.mock.calls.map(([args]) => args.path)).toEqual([
        'Inbox/Call the plumber.md',
      ]),
    );
  });

  it('says a vault is needed when the global shortcut is pressed with none open (#81)', async () => {
    const capture = fakeGlobalCapture();
    renderApp(fakeVault(), memoryActivityStore(), capture);
    await screen.findByRole('heading', { name: 'Open a vault' });
    await vi.waitFor(() => expect(capture.asked).toHaveLength(1));

    capture.press();

    expect(
      await screen.findByText(
        'Quick capture needs a vault: open one, and what you capture lands in its Inbox.',
      ),
    ).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'Capture a task' })).toBeNull();
  });

  it("opens today's note with Shift+Cmd+D", async () => {
    renderApp(vaultWith());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}{Shift>}d{/Shift}{/Meta}');

    expect(await screen.findByRole('article', { name: localToday() })).toBeDefined();
  });

  it('makes no note from Cmd+N or Shift+Cmd+D behind the search palette (A14-08)', async () => {
    const vault = vaultWith();
    const createNote = vi.spyOn(vault.fs, 'createNote');
    renderApp(vault);
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('dialog', { name: 'Search notes' });
    await userEvent.keyboard('{Meta>}n{/Meta}');
    await userEvent.keyboard('{Meta>}{Shift>}d{/Shift}{/Meta}');
    await userEvent.keyboard('{Escape}');

    // Control, and the clock for the check: Cmd+N now makes "Untitled". Had
    // either press behind the palette made a note, it would be listed first.
    await userEvent.keyboard('{Meta>}n{/Meta}');
    expect(await screen.findByRole('article', { name: 'Untitled' })).toBeDefined();
    expect(createNote.mock.calls.map(([args]) => args.path)).toEqual(['Untitled.md']);
  });

  it('opens a new query from the palette, by the word "sql"', async () => {
    renderApp(vaultWith());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.click(await screen.findByLabelText('Search the vault'));
    await userEvent.paste('sql');
    await userEvent.click(await screen.findByRole('option', { name: /New query/ }));

    expect(await screen.findByRole('region', { name: 'Query' })).toBeDefined();
    expect(searchPalette()).toBeNull();
  });

  it.each([
    ['New view', 'View name'],
    ['New artifact', 'Link'],
  ])('puts up %s from the palette in its place', async (command, field) => {
    renderApp(vaultWith());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.click(await screen.findByLabelText('Search the vault'));
    await userEvent.paste(command);
    await userEvent.click(await screen.findByRole('option', { name: new RegExp(command) }));

    const dialog = await screen.findByRole('dialog', { name: command });
    expect(within(dialog).getByLabelText(field)).toBeDefined();
    expect(searchPalette()).toBeNull();
  });

  it('hides the sidebar with Cmd+\\ and brings it back the same way', async () => {
    renderApp(vaultWith());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}\\{/Meta}');
    expect(screen.queryByRole('treeitem', { name: 'recipes' })).toBeNull();

    await userEvent.keyboard('{Meta>}\\{/Meta}');
    expect(await screen.findByRole('treeitem', { name: 'recipes' })).toBeDefined();
  });
});

describe('the dialogs the sidebar opens', () => {
  const vaultWith = () =>
    fakeVault({
      remembered: location,
      directories: { '': [entry('recipes.md', 'file')] },
      files: { 'recipes.md': '# Recipes\n' },
    });

  it('opens New type from the sidebar and closes it again', async () => {
    renderApp(vaultWith());
    await userEvent.click(await screen.findByRole('button', { name: 'New type' }));

    const dialog = await screen.findByRole('dialog', { name: 'New type' });
    expect(within(dialog).getByLabelText('Type name')).toBeDefined();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'New type' })).toBeNull();
  });

  it('opens New view from the Views "+" and closes it again', async () => {
    renderApp(vaultWith());
    await userEvent.click(await screen.findByRole('button', { name: 'New in Views' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New view' }));

    const dialog = await screen.findByRole('dialog', { name: 'New view' });
    expect(within(dialog).getByLabelText('View name')).toBeDefined();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'New view' })).toBeNull();
  });

  it('opens New artifact from the new-note menu and closes it again', async () => {
    renderApp(vaultWith());
    await userEvent.click(await screen.findByRole('button', { name: 'New note' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Claude artifact…' }));

    const dialog = await screen.findByRole('dialog', { name: 'New artifact' });
    expect(within(dialog).getByLabelText('Link')).toBeDefined();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'New artifact' })).toBeNull();
  });
});

describe('the day the app calls today', () => {
  const zone = process.env.TZ;

  beforeEach(() => {
    // Eight in the evening in California is already tomorrow in UTC, which is
    // where a today-line drawn from toISOString used to land.
    process.env.TZ = 'America/Los_Angeles';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T03:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('is the day where the person is, the way the index reads @today', () => {
    expect(localToday()).toBe('2026-09-20');
  });
});

describe('the Activity log, adversarial (U-28)', () => {
  it('keeps one error line for one index failure, not one from the index and one from its notice', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('todo.md', 'file')] },
    });
    const failing = fakeIndexPorts(vault);
    const activity = memoryActivityStore();
    render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={vault}
        notes={notesFor(vault)}
        index={{
          ...failing,
          index: { ...failing.index, open: () => Promise.reject(new Error('disk I/O error')) },
        }}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={activityIn(activity)}
        sync={noSync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );
    // The window shows the failure as a red notice; both lines are batched into one write.
    expect((await screen.findAllByText(/disk I\/O error/)).length).toBeGreaterThan(0);
    const kept = () => activity.files.get(location.absolutePath) ?? '';
    await vi.waitFor(() => expect(kept()).toContain('disk I/O error'));
    const errors = kept()
      .split('\n')
      .filter((line) => line.includes('"level":"error"'));
    expect(errors).toHaveLength(1);
  });

  it('keeps one error line for a sidebar order that could not be saved, not one from its notice too', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('todo.md', 'file')] },
      files: { 'todo.md': '# Todo\n' },
    });
    const refuseSettings = (path: string) => {
      if (path.startsWith('.atlas/')) throw new VaultAccessError('the settings note is locked');
    };
    const { createNote, writeTextFile } = vault.fs;
    vault.fs.createNote = async (args) => {
      refuseSettings(args.path);
      return createNote(args);
    };
    vault.fs.writeTextFile = async (args) => {
      refuseSettings(args.path);
      return writeTextFile(args);
    };
    const activity = memoryActivityStore();
    renderApp(vault, activity);

    (await screen.findByRole('button', { name: 'Move Favorites' })).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(await screen.findByText(/The sidebar's order could not be saved/)).toBeDefined();

    const kept = () => activity.files.get(location.absolutePath) ?? '';
    await vi.waitFor(() => expect(kept()).toContain('the settings note is locked'));
    const errors = kept()
      .split('\n')
      .filter((line) => line.includes('"level":"error"'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Could not save a setting.');
  });
});

describe('opening a vault while its index is still being built (ADR-0034)', () => {
  it('reads the vault into the index once: the catch-up Granola waits on waits for the build', async () => {
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('todo.md', 'file')] },
      files: { 'todo.md': '# Todo\n' },
    });
    const ports = fakeIndexPorts(vault);
    let syncs = 0;
    let finishBuild = () => {};
    const building = new Promise<void>((resolve) => (finishBuild = resolve));
    const index = {
      ...ports,
      index: {
        ...ports.index,
        // Every sync of the index opens it first; the build, the first, is held.
        open: async () => {
          syncs += 1;
          if (syncs === 1) await building;
          return { fresh: false };
        },
      },
    };
    // Sync is not set up, so the vault is ready for Granola, and its catch-up asked, as soon as sync has looked.
    let looked = false;
    const sync = {
      ...noSync,
      git: () => {
        const git = noSync.git();
        return {
          ...git,
          topLevel: async () => {
            const answer = await git.topLevel();
            looked = true;
            return answer;
          },
        };
      },
    };
    render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={vault}
        notes={notesFor(vault)}
        index={index}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={activityIn()}
        sync={sync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );
    await vi.waitFor(() => expect(looked).toBe(true));
    // The catch-up is asked while the build is still under way.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(syncs).toBe(1);

    act(() => finishBuild());
    expect(await screen.findByText('0 notes indexed')).toBeDefined();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(syncs).toBe(1);
  });
});

describe('reading the vault after a change (#259)', () => {
  /**
   * What the window reads of the index and the vault, by the number of index
   * writes made when it asked: a read asked while the count was still `n` was
   * set off by the change that made write `n`.
   */
  function countingReads(vault: ReturnType<typeof fakeVault>) {
    const index = memoryIndexPort();
    let puts = 0;
    const reads = { graph: [] as number[], views: [] as number[] };
    const listed = { types: [] as number[], templates: [] as number[] };
    // Each sync ends by counting the index, after its last write: then it settles.
    const counted: number[] = [];
    const ports: IndexPorts = {
      fs: vault.fs,
      markdown: remarkMarkdown,
      index: {
        ...index,
        put: async (notes, scope) => {
          await index.put(notes, scope);
          puts += 1;
        },
        query: async (sql, parameters) => {
          if (sql.includes('/* graph:notes */')) reads.graph.push(puts);
          return index.query(sql, parameters);
        },
        rebuildViews: async () => void reads.views.push(puts),
        stats: async () => {
          counted.push(puts);
          return index.stats();
        },
      },
    };
    const fs: VaultFsPort = {
      ...vault.fs,
      listDirectory: async (path) => {
        if (path === '.atlas/types') listed.types.push(puts);
        if (path === '.atlas/templates') listed.templates.push(puts);
        return vault.fs.listDirectory(path);
      },
    };
    /** Waits for the sync that made write `n` to settle: counted, then said ready. */
    const settledAfter = async (n: number) => {
      await vi.waitFor(() => expect(counted).toContain(n));
      await act(async () => {});
    };
    return { ports, fs, reads, listed, puts: () => puts, settledAfter };
  }

  it('reads the graph again for a change to its links, and nothing for a change to a body alone', async () => {
    const files: Record<string, string> = {
      'a.md': '# A\n\nSome words.\n',
      'b.md': '# B\n',
      '.atlas/types/book.md': '---\nname: book\nlabel: Book\nproperties:\n  author: text\n---\n',
      '.atlas/templates/Book.md': '---\ntype: book\n---\n',
    };
    const vault = fakeVault({
      remembered: location,
      directories: {
        '': [entry('a.md', 'file'), entry('b.md', 'file')],
        '.atlas/types': [entry('.atlas/types/book.md', 'file')],
        '.atlas/templates': [entry('.atlas/templates/Book.md', 'file')],
      },
      files,
    });
    const counting = countingReads(vault);
    const heard: ((paths: readonly string[]) => void)[] = [];
    const watch = {
      start: async () => {},
      onChange: async (handler: (paths: readonly string[]) => void) => {
        heard.push(handler);
        return () => {};
      },
    };
    const watched = { ...vault, fs: counting.fs, watch };
    render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={watched}
        notes={notesFor(watched)}
        index={{ ...counting.ports, fs: counting.fs }}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={activityIn()}
        sync={noSync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );
    // The first build writes the vault once; the graph, tags, types and views are read after it.
    await vi.waitFor(() => expect(counting.reads.graph).toContain(1));
    await vi.waitFor(() => expect(counting.reads.views.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    const before = {
      views: counting.reads.views.length,
      types: counting.listed.types.length,
      templates: counting.listed.templates.length,
    };
    const tell = (paths: readonly string[]) =>
      act(() => heard.forEach((handler) => handler(paths)));

    // Another program edits a's body: words only, no link, no tag.
    files['a.md'] = '# A\n\nSome more words, and then some.\n';
    await tell(['a.md']);
    await vi.waitFor(() => expect(counting.puts()).toBe(2));
    // Settled before the next edit: a graph read this edit set off would have begun by now.
    await counting.settledAfter(2);

    // Then it links a to b: the graph has a new edge, and is read again.
    files['a.md'] = '# A\n\nSome more words, and then some. See [[b]].\n';
    await tell(['a.md']);
    await vi.waitFor(() => expect(counting.reads.graph).toContain(3));

    // Nothing read the graph for the body alone, nor the types, the templates
    // or the views for either edit. (The tags have another reader still on
    // the index's key, the query builder's choices, so they are held by
    // reporting-index-writes.test.ts instead.)
    expect(counting.reads.graph).not.toContain(2);
    expect(counting.reads.views.length).toBe(before.views);
    expect(counting.listed.types.length).toBe(before.types);
    expect(counting.listed.templates.length).toBe(before.templates);
  });
});

describe('the window’s kept reads, attacked (#259, PR 272)', () => {
  type Faults = {
    /** Throws on the window's own reads of the type definitions until `heal` is called. */
    typesUntilHealed?: boolean;
    /** Throws on the first graph read when set. */
    graphOnce?: boolean;
    /** Rejects the first view rebuild when set. */
    viewsOnce?: boolean;
  };

  /**
   * A watched vault on an in-memory index, counting what the window reads by
   * the number of index writes made when it asked. A fault, when asked for,
   * happens once and never again: what a transient failure leaves behind.
   */
  function watchedVault({
    files,
    directories,
    faults = {},
  }: {
    files: Record<string, string>;
    directories: Record<string, VaultEntry[]>;
    faults?: Faults;
  }) {
    const vault = fakeVault({ remembered: location, directories, files });
    const index = memoryIndexPort();
    let puts = 0;
    const left = { ...faults };
    const reads = { graph: [] as number[], views: [] as number[] };
    const listed = { types: [] as number[], templates: [] as string[] };
    const typeReads: string[] = [];
    const indexPorts: IndexPorts = {
      fs: vault.fs,
      markdown: remarkMarkdown,
      index: {
        ...index,
        put: async (notes, scope) => {
          await index.put(notes, scope);
          puts += 1;
        },
        query: async (sql, parameters) => {
          if (sql.includes('/* graph:notes */')) {
            reads.graph.push(puts);
            if (left.graphOnce === true) {
              left.graphOnce = false;
              throw new Error('database is locked');
            }
          }
          return index.query(sql, parameters);
        },
        rebuildViews: async () => {
          reads.views.push(puts);
          if (left.viewsOnce === true) {
            left.viewsOnce = false;
            throw new Error('database is locked');
          }
        },
      },
    };
    const fs: VaultFsPort = {
      ...vault.fs,
      listDirectory: async (path) => {
        if (path === '.atlas/types') listed.types.push(puts);
        if (path.startsWith('.atlas/templates')) listed.templates.push(path);
        return vault.fs.listDirectory(path);
      },
      readNotes: async (paths) => {
        const onlyTypes = paths.length > 0 && paths.every((p) => p.startsWith('.atlas/types/'));
        // The window's read of its types, not the one setting built-in types up.
        const windowRead = onlyTypes && !(new Error().stack ?? '').includes('setUpTypes');
        if (windowRead) typeReads.push(left.typesUntilHealed === true ? 'failed' : 'read');
        if (windowRead && left.typesUntilHealed === true) {
          throw new VaultAccessError('the disk was busy');
        }
        return vault.fs.readNotes(paths);
      },
    };
    const heard: ((paths: readonly string[]) => void)[] = [];
    const watch = {
      start: async () => {},
      onChange: async (handler: (paths: readonly string[]) => void) => {
        heard.push(handler);
        return () => {};
      },
    };
    const watched = { ...vault, fs, watch };
    render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={watched}
        notes={notesFor(watched)}
        index={{ ...indexPorts, fs }}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={activityIn()}
        sync={noSync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );
    /** Another program changed these paths; the watcher says so. */
    const tell = (paths: readonly string[]) =>
      act(() => heard.forEach((handler) => handler(paths)));
    /** Waits until the first build has written and the watcher is listening. */
    const opened = async () => {
      await vi.waitFor(() => expect(puts).toBeGreaterThan(0));
      await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    };
    const heal = () => {
      left.typesUntilHealed = false;
    };
    return { files, directories, reads, listed, typeReads, heal, puts: () => puts, tell, opened };
  }

  const BOOK = '---\nname: book\nlabel: Book\nproperties:\n  author: text\n---\n';

  function bookVault(faults?: Faults, extra: Record<string, string> = {}) {
    const files: Record<string, string> = {
      'a.md': '# A\n\nSome words.\n',
      'b.md': '# B\n',
      '.atlas/types/book.md': BOOK,
      '.atlas/templates/Book.md': '---\ntype: book\n---\n',
      ...extra,
    };
    const notes = Object.keys(files).filter((path) => !path.startsWith('.atlas/'));
    return watchedVault({
      files,
      directories: {
        '': notes.map((path) => entry(path, 'file')),
        '.atlas/types': [entry('.atlas/types/book.md', 'file')],
        '.atlas/templates': [entry('.atlas/templates/Book.md', 'file')],
      },
      ...(faults !== undefined && { faults }),
    });
  }

  // --- What held: each of these must read again, and does. ---

  it('reads the graph again when a note gains a link through a frontmatter relation', async () => {
    const vault = bookVault();
    await vault.opened();
    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(0));
    const before = vault.reads.graph.length;

    vault.files['a.md'] = '---\nrelated: "[[b]]"\n---\n# A\n\nSome words.\n';
    await vault.tell(['a.md']);

    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(before));
  });

  it('reads the graph again when a linked note is deleted by another program', async () => {
    const vault = bookVault(undefined, { 'a.md': '# A\n\nSee [[b]].\n' });
    await vault.opened();
    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(0));
    const before = vault.reads.graph.length;

    delete vault.files['b.md'];
    vault.directories[''] = (vault.directories[''] ?? []).filter((item) => item.path !== 'b.md');
    await vault.tell(['b.md']);

    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(before));
  });

  it('lists the types again and rebuilds the views for an outside edit to a type', async () => {
    const vault = bookVault();
    await vault.opened();
    await vi.waitFor(() => expect(vault.reads.views.length).toBeGreaterThan(0));
    const before = { types: vault.listed.types.length, views: vault.reads.views.length };

    vault.files['.atlas/types/book.md'] = BOOK.replace(
      '  author: text\n',
      '  author: text\n  genre: text\n',
    );
    await vault.tell(['.atlas/types/book.md']);

    await vi.waitFor(() => expect(vault.listed.types.length).toBeGreaterThan(before.types));
    await vi.waitFor(() => expect(vault.reads.views.length).toBeGreaterThan(before.views));
  });

  it('lists the templates again for one another program adds in a nested folder', async () => {
    const vault = bookVault();
    await vault.opened();
    await vi.waitFor(() => expect(vault.listed.templates.length).toBeGreaterThan(0));
    const before = vault.listed.templates.length;

    vault.files['.atlas/templates/People/Person.md'] = '---\ntype: person\n---\n';
    vault.directories['.atlas/templates'] = [
      ...(vault.directories['.atlas/templates'] ?? []),
      entry('.atlas/templates/People', 'directory'),
    ];
    vault.directories['.atlas/templates/People'] = [
      entry('.atlas/templates/People/Person.md', 'file'),
    ];
    await vault.tell(['.atlas/templates/People/Person.md']);

    await vi.waitFor(() => expect(vault.listed.templates.length).toBeGreaterThan(before));
  });

  it('reads the graph again when a bulk retag of 60 notes also links one of them', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, at) => [`n${String(at).padStart(2, '0')}.md`, `# N${at}\n`]),
    );
    const vault = bookVault(undefined, many);
    await vault.opened();
    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(0));
    const before = vault.reads.graph.length;

    // Every note is retagged; only the last, in the second batch of 50, gains a link.
    for (const path of Object.keys(many)) vault.files[path] = `${many[path]}\n#bulk\n`;
    vault.files['n59.md'] = '# N59\n\n#bulk [[b]]\n';
    await vault.tell(Object.keys(many));

    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(before));
  });

  // --- Bugs: a read that failed once is kept as it failed. ---

  /** Opens a vault whose window reads of its types fail, then the disk recovers. */
  async function openedWithTypesFailing() {
    const vault = bookVault({ typesUntilHealed: true });
    await vault.opened();
    await vi.waitFor(() => expect(vault.typeReads).toContain('failed'));
    // Let the opening settle: the build, the built-in types' set-up, and their reads.
    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(0));
    await act(async () => {});
    vault.heal();
    // Any later change to the vault: before #259 the types were read again on it.
    vault.files['a.md'] = '# A\n\nSome words, and a link to [[b]].\n';
    await vault.tell(['a.md']);
    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(1));
    return vault;
  }

  it('reads the types again after a read of them failed, once the index next moves', async () => {
    const vault = await openedWithTypesFailing();

    // The failed read was kept as "no types", with no error shown, for good:
    // until a type file itself changes, or the app restarts.
    await vi.waitFor(() => expect(vault.typeReads).toContain('read'), { timeout: 1500 });
  });

  it('rebuilds the SQL views once the types can be read after a failed first read', async () => {
    const vault = await openedWithTypesFailing();

    // book is defined on disk, so its view must exist for its table to read.
    await vi.waitFor(() => expect(vault.reads.views.length).toBeGreaterThan(0), {
      timeout: 1500,
    });
  });

  it('reads the graph again after a read of it failed, once the index next moves', async () => {
    const vault = bookVault({ graphOnce: true });
    await vault.opened();
    await vi.waitFor(() => expect(vault.reads.graph.length).toBe(1));

    // An edit that changes no facet: the index moves, the failed graph stays failed.
    vault.files['a.md'] = '# A\n\nSome more words, and then some.\n';
    await vault.tell(['a.md']);
    await vi.waitFor(() => expect(vault.puts()).toBeGreaterThan(1));

    await vi.waitFor(() => expect(vault.reads.graph.length).toBeGreaterThan(1), {
      timeout: 1500,
    });
  });

  it('rebuilds the SQL views again after a rebuild failed, once the index next moves', async () => {
    const vault = bookVault({ viewsOnce: true });
    await vault.opened();
    await vi.waitFor(() => expect(vault.reads.views.length).toBe(1));

    vault.files['a.md'] = '# A\n\nSome more words, and then some.\n';
    await vault.tell(['a.md']);
    await vi.waitFor(() => expect(vault.puts()).toBeGreaterThan(1));

    await vi.waitFor(() => expect(vault.reads.views.length).toBeGreaterThan(1), {
      timeout: 1500,
    });
  });
});

describe('what ⌘K draws (#261)', () => {
  it('opens the palette and takes five keys without drawing the window, its sidebar or its panes again', async () => {
    renderApp(
      fakeVault({
        remembered: location,
        directories: { '': [entry('recipes.md', 'file')] },
        files: { 'recipes.md': '# Recipes\n\nSourdough.\n' },
      }),
    );
    await userEvent.click(await screen.findByRole('treeitem', { name: 'recipes' }));
    await screen.findByRole('article', { name: 'recipes' });
    // Whatever opening the note set going settles before counting starts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    startCountingRenders();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.type(await screen.findByLabelText('Search the vault'), 'sourd');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const { renders } = stopCountingRenders();

    // The counter saw the palette drawn for each key, so a zero below is real.
    expect(renders.SearchPalette ?? 0).toBeGreaterThanOrEqual(5);
    expect(renders.AppWindow ?? 0).toBe(0);
    expect(renders.AppShell ?? 0).toBe(0);
    expect(renders.VaultTree ?? 0).toBe(0);
    expect(renders.PaneFrame ?? 0).toBe(0);
    expect(renders.NotePaneContainer ?? 0).toBe(0);
  });
});

describe('⌘K held in the overlay store (#261, attack)', () => {
  const twoNotes = () =>
    fakeVault({
      remembered: location,
      directories: { '': [entry('recipes.md', 'file'), entry('garden.md', 'file')] },
      files: { 'recipes.md': '# Recipes\n\nSourdough.\n', 'garden.md': '# Garden\n\nTomatoes.\n' },
    });
  const searchPalette = () => screen.queryByRole('dialog', { name: 'Search notes' });
  const searchBox = () => screen.findByLabelText<HTMLInputElement>('Search the vault');

  /** The app on a vault whose index answers every search with recipes. */
  const renderFinding = (vault: ReturnType<typeof fakeVault>) => {
    const index = fakeIndexPorts(vault);
    index.index.search = async () => [
      { path: 'recipes.md', title: 'Recipes', snippet: '<<Sourdough>>' },
    ];
    return render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={vault}
        notes={notesFor(vault)}
        index={index}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={activityIn()}
        sync={noSync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );
  };

  async function openGardenThenRecipes() {
    await userEvent.click(await screen.findByRole('treeitem', { name: 'garden' }));
    await screen.findByRole('article', { name: 'garden' });
    await userEvent.click(screen.getByRole('treeitem', { name: 'recipes' }));
    await screen.findByRole('article', { name: 'recipes' });
  }

  it('opens empty again after a note was picked from it', async () => {
    renderFinding(twoNotes());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.type(await searchBox(), 'sour');
    await userEvent.click(await screen.findByRole('option', { name: /Recipes/ }));
    await screen.findByRole('article', { name: 'recipes' });
    await userEvent.keyboard('{Meta>}k{/Meta}');

    expect((await searchBox()).value).toBe('');
    expect(screen.queryByRole('option', { name: /Recipes/ })).toBeNull();
  });

  it('opens with archived notes left out again after the toggle was turned on and the palette shut', async () => {
    renderFinding(twoNotes());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.click(await screen.findByRole('switch', { name: 'Include archived' }));
    expect(
      screen.getByRole('switch', { name: 'Include archived' }).getAttribute('aria-checked'),
    ).toBe('true');
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Meta>}k{/Meta}');

    const toggle = await screen.findByRole('switch', { name: 'Include archived' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps ⌘K the only dialog, with the focus in its box, through Shift+Cmd+N, Cmd+, and Cmd+J', async () => {
    renderFinding(twoNotes());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    const box = await searchBox();
    await userEvent.keyboard('{Meta>}{Shift>}n{/Shift}{/Meta}');
    await userEvent.keyboard('{Meta>},{/Meta}');
    await userEvent.keyboard('{Meta>}j{/Meta}');
    await userEvent.keyboard('{Meta>}{Alt>}n{/Alt}{/Meta}');

    const dialogs = screen.getAllByRole('dialog', { hidden: true });
    expect(dialogs.map((d) => d.getAttribute('aria-label'))).toEqual(['Search notes']);
    expect(document.activeElement).toBe(box);
  });

  it('does not go back behind the palette on Cmd+[', async () => {
    renderFinding(twoNotes());
    await openGardenThenRecipes();

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await searchBox();
    await userEvent.keyboard('{Meta>}[[{/Meta}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    // The modal palette hides the window from the accessibility tree, so look behind it.
    expect(screen.getByRole('article', { name: 'recipes', hidden: true })).toBeDefined();
    expect(screen.queryByRole('article', { name: 'garden', hidden: true })).toBeNull();
    expect(searchPalette()).not.toBeNull();
  });

  it('does not split the window behind the palette on Shift+Cmd+\\', async () => {
    renderFinding(twoNotes());
    await userEvent.click(await screen.findByRole('treeitem', { name: 'recipes' }));
    await screen.findByRole('article', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await searchBox();
    await userEvent.keyboard('{Meta>}{Shift>}\\{/Shift}{/Meta}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    // The modal palette hides the window from the accessibility tree, so look behind it.
    expect(screen.queryByRole('region', { name: 'Pane 1', hidden: true })).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Pane 2', hidden: true })).toBeNull();
    // Control: with the palette shut, the same press splits.
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Meta>}{Shift>}\\{/Shift}{/Meta}');
    expect(await screen.findByRole('region', { name: 'Pane 2' })).toBeDefined();
  });

  it('does not hide the sidebar behind the palette on Cmd+\\', async () => {
    renderFinding(twoNotes());
    await screen.findByRole('treeitem', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await searchBox();
    await userEvent.keyboard('{Meta>}\\{/Meta}');

    // The modal palette hides the window from the accessibility tree, so look behind it.
    expect(screen.queryByRole('treeitem', { name: 'recipes', hidden: true })).not.toBeNull();
  });

  it('gives the focus back to what had it before ⌘K, once Escape shuts it', async () => {
    renderFinding(twoNotes());
    const item = await screen.findByRole('treeitem', { name: 'recipes' });
    act(() => item.focus());

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await searchBox();
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(document.activeElement).toBe(item));
  });

  it('opens a pane menu once ⌘K is shut, so the window still draws its own overlays', async () => {
    renderFinding(twoNotes());
    await userEvent.click(await screen.findByRole('treeitem', { name: 'recipes' }));
    await screen.findByRole('article', { name: 'recipes' });

    await userEvent.keyboard('{Meta>}k{/Meta}');
    await searchBox();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(await screen.findByRole('menuitem', { name: /^Split right/ })).toBeDefined();
    expect(searchPalette()).toBeNull();
  });

  it('lets ⌘K replace an open pane menu, leaving only the palette up', async () => {
    renderFinding(twoNotes());
    await userEvent.click(await screen.findByRole('treeitem', { name: 'recipes' }));
    await screen.findByRole('article', { name: 'recipes' });
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await screen.findByRole('menuitem', { name: /^Split right/ });

    await userEvent.keyboard('{Meta>}k{/Meta}');

    expect(await searchBox()).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: /^Split right/ })).toBeNull(),
    );
  });

  it('moves the choice and shuts ⌘K without drawing the window again', async () => {
    renderFinding(twoNotes());
    await userEvent.click(await screen.findByRole('treeitem', { name: 'recipes' }));
    await screen.findByRole('article', { name: 'recipes' });
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.type(await searchBox(), 'sour');
    await screen.findByRole('option', { name: /Recipes/ });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    startCountingRenders();
    await userEvent.keyboard('{ArrowDown}{ArrowUp}');
    await userEvent.click(screen.getByRole('switch', { name: 'Include archived' }));
    await userEvent.keyboard('{Escape}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const { renders } = stopCountingRenders();

    expect(renders.SearchPalette ?? 0).toBeGreaterThanOrEqual(3);
    expect(renders.AppWindow ?? 0).toBe(0);
    expect(renders.PaneFrame ?? 0).toBe(0);
    expect(renders.VaultTree ?? 0).toBe(0);
  });
});

describe('tabs (docs/design/tab-model.md, Performance 8)', () => {
  // jsdom lays nothing out, and ProseMirror measures the selection when the
  // focus lands back in an editor after a switch.
  beforeAll(() => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  });

  const twoNotes = () =>
    fakeVault({
      remembered: location,
      directories: { '': [entry('alpha.md', 'file'), entry('beta.md', 'file')] },
      files: { 'alpha.md': '# Alpha\n\nThe first.\n', 'beta.md': '# Beta\n\nThe second.\n' },
    });

  const pane = (which: 1 | 2) => screen.getByRole('region', { name: `Pane ${which}` });
  const tabsOf = (which: 1 | 2) =>
    within(pane(which))
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
  const tabIn = (which: 1 | 2, name: string) => within(pane(which)).getByRole('tab', { name });
  const row = (name: string) => screen.getByRole('treeitem', { name });
  /** Lets whatever an open set going settle, so a count that follows is the action's alone. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

  /** ⌘-clicks a row: the modifier is held across the click by one user, as a hand holds it. */
  async function commandClick(element: HTMLElement) {
    const user = userEvent.setup();
    await user.keyboard('{Meta>}');
    await user.click(element);
    await user.keyboard('{/Meta}');
  }

  /** Opens alpha, then beta in a tab beside it, so the pane holds both. */
  async function alphaThenBetaInTabs(vault = twoNotes()) {
    renderApp(vault);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'alpha' }));
    await screen.findByRole('article', { name: 'alpha' });
    await commandClick(row('beta'));
    await screen.findByRole('article', { name: 'beta' });
    expect(tabsOf(1)).toEqual(['alpha', 'beta']);
    return vault;
  }

  it('opens a ⌘-clicked note in a new tab beside the active one, and a plain click activates an open tab', async () => {
    await alphaThenBetaInTabs();
    expect(tabIn(1, 'beta').getAttribute('aria-selected')).toBe('true');

    await userEvent.click(row('alpha'));
    expect(tabsOf(1)).toEqual(['alpha', 'beta']);
    expect(tabIn(1, 'alpha').getAttribute('aria-selected')).toBe('true');
    // A plain click on a note no tab holds replaces the active one.
    await userEvent.click(await screen.findByRole('treeitem', { name: 'beta' }));
    expect(tabIn(1, 'beta').getAttribute('aria-selected')).toBe('true');
    // Beside the active tab, which is beta's now: so a run of ⌘-clicks reads in order.
    await commandClick(row('alpha'));
    expect(tabsOf(1)).toEqual(['alpha', 'beta', 'alpha']);
  });

  it('closes a tab with ⌘W, never the window, and brings it back with ⌘⇧T', async () => {
    await alphaThenBetaInTabs();
    await userEvent.keyboard('{Meta>}w{/Meta}');
    expect(tabsOf(1)).toEqual(['alpha']);
    await userEvent.keyboard('{Meta>}w{/Meta}');
    expect(tabsOf(1)).toEqual(['New tab']);
    expect(pane(1)).toBeDefined();
    await userEvent.keyboard('{Meta>}{Shift>}t{/Shift}{/Meta}');
    expect(tabsOf(1)).toEqual(['alpha']);
    expect(await within(pane(1)).findByRole('article', { name: 'alpha' })).toBeDefined();
  });

  it('switching tabs draws the strip and the shown tab alone: not the app, the shell, the tree or the other pane', async () => {
    await alphaThenBetaInTabs();
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Split right/ }));
    await screen.findByRole('region', { name: 'Pane 2' });
    await userEvent.click(within(pane(1)).getByRole('article', { name: 'beta' }));
    await settle();

    startCountingRenders();
    await userEvent.click(tabIn(1, 'alpha'));
    await settle();
    const { renders } = stopCountingRenders();

    expect(tabIn(1, 'alpha').getAttribute('aria-selected')).toBe('true');
    // The strip drawn, so the zeros below are real; alpha's editor was kept
    // mounted and is shown again, beta's hides: one draw each, none for pane 2.
    expect(renders.TabStrip ?? 0).toBe(1);
    expect(renders.NotePaneContainer ?? 0).toBe(2);
    expect(renders.AppWindow ?? 0).toBe(0);
    expect(renders.AppShell ?? 0).toBe(0);
    expect(renders.PaneFrame ?? 0).toBe(0);
    // The sidebar moves its mark from beta to alpha, and draws the tree once for it.
    expect(renders.VaultTree ?? 0).toBe(1);
  });

  it('switching between tabs on the same note draws the tree not at all', async () => {
    await alphaThenBetaInTabs();
    await commandClick(row('beta'));
    expect(tabsOf(1)).toEqual(['alpha', 'beta', 'beta']);
    await settle();

    startCountingRenders();
    await userEvent.click(within(pane(1)).getAllByRole('tab', { name: 'beta' })[0] as HTMLElement);
    await settle();
    const { renders } = stopCountingRenders();

    expect(renders.TabStrip ?? 0).toBe(1);
    expect(renders.VaultTree ?? 0).toBe(0);
    expect(renders.AppWindow ?? 0).toBe(0);
  });

  it('focusing the other pane draws the frames and strips, not the pages in them', async () => {
    await alphaThenBetaInTabs();
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Split right/ }));
    await screen.findByRole('region', { name: 'Pane 2' });
    await settle();

    startCountingRenders();
    await userEvent.click(within(pane(1)).getByRole('article', { name: 'beta' }));
    await settle();
    const { renders } = stopCountingRenders();

    expect(renders.PaneFrame ?? 0).toBe(2);
    expect(renders.TabStrip ?? 0).toBe(2);
    expect(renders.NotePaneContainer ?? 0).toBe(0);
    expect(renders.NotePane ?? 0).toBe(0);
    expect(renders.AppWindow ?? 0).toBe(0);
    expect(renders.AppShell ?? 0).toBe(0);
  });

  it('⌘[ steps the focused tab back and draws nothing in the other pane', async () => {
    const vault = twoNotes();
    renderApp(vault);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'alpha' }));
    await screen.findByRole('article', { name: 'alpha' });
    await userEvent.click(row('beta'));
    await screen.findByRole('article', { name: 'beta' });
    await settle();

    // What the step costs alone: the tab's note read and drawn.
    startCountingRenders();
    await userEvent.keyboard('{Meta>}[[{/Meta}');
    await within(pane(1)).findByRole('article', { name: 'alpha' });
    await settle();
    const alone = stopCountingRenders().renders;
    expect(alone.NotePaneContainer ?? 0).toBeGreaterThan(0);

    await userEvent.keyboard('{Meta>}]]{/Meta}');
    await within(pane(1)).findByRole('article', { name: 'beta' });
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Split right/ }));
    await within(pane(2)).findByRole('article', { name: 'beta' });
    await settle();

    // The same step in the focused pane 2, with pane 1 beside it: the same cost.
    startCountingRenders();
    await userEvent.keyboard('{Meta>}[[{/Meta}');
    await within(pane(2)).findByRole('article', { name: 'alpha' });
    await settle();
    const { renders } = stopCountingRenders();

    expect(within(pane(1)).getByRole('article', { name: 'beta' })).toBeDefined();
    expect(renders.NotePaneContainer ?? 0).toBe(alone.NotePaneContainer);
    expect(renders.NotePane ?? 0).toBe(alone.NotePane);
    expect(renders.TabStrip ?? 0).toBe(1);
    expect(renders.PaneFrame ?? 0).toBe(0);
    expect(renders.AppWindow ?? 0).toBe(0);
  });

  it('opening from the sidebar draws neither the app nor the shell', async () => {
    const vault = twoNotes();
    renderApp(vault);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'alpha' }));
    await screen.findByRole('article', { name: 'alpha' });
    await settle();

    startCountingRenders();
    await userEvent.click(row('beta'));
    await screen.findByRole('article', { name: 'beta' });
    await settle();
    const { renders } = stopCountingRenders();

    expect(renders.NotePaneContainer ?? 0).toBeGreaterThan(0);
    expect(renders.AppWindow ?? 0).toBe(0);
    expect(renders.AppShell ?? 0).toBe(0);
  });

  it('draws the shown tab alone when the window is drawn again: a hidden tab waits as it was', async () => {
    await alphaThenBetaInTabs();
    await settle();

    // Hiding the sidebar draws the whole window, as any change of the app's own state does.
    startCountingRenders();
    await userEvent.keyboard('{Meta>}\\{/Meta}');
    await settle();
    const { renders } = stopCountingRenders();

    expect(renders.AppWindow ?? 0).toBeGreaterThan(0);
    expect(renders.NotePaneContainer ?? 0).toBe(1);
  });

  it('lets no editor of one vault outlive the switch to the next: a star there never writes the old vault’s text (R14-01)', async () => {
    const other: VaultLocation = { absolutePath: '/Users/j/Other', name: 'Other' };
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('shared.md', 'file'), entry('beta.md', 'file')] },
      files: { 'shared.md': '# Shared\n\nIn A.\n', 'beta.md': '# Beta\n' },
      elsewhere: {
        [other.absolutePath]: { 'shared.md': '# Shared\n\nIn B.\n', 'beta.md': '# Beta\n' },
      },
      picks: [other],
    });
    renderApp(vault);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'shared' }));
    await screen.findByRole('article', { name: 'shared' });
    await commandClick(row('beta'));
    await screen.findByRole('article', { name: 'beta' });
    expect(tabsOf(1)).toEqual(['shared', 'beta']);
    // The other vault remembers the same tabs, with the same ids, on the same paths.
    const remembered = window.localStorage.getItem(`atlas.workspace:${location.absolutePath}`);
    window.localStorage.setItem(
      `atlas.workspace:${other.absolutePath}`,
      (remembered ?? '').replace(location.absolutePath, other.absolutePath),
    );

    // Its notes take their time to arrive: the window in which an editor kept
    // from the first vault would still hold that vault's text.
    const reads = vault.holdReads();
    await userEvent.click(screen.getByRole('button', { name: 'Vault' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Open another folder…' }));
    expect(await screen.findByRole('button', { name: 'Other' })).toBeDefined();
    expect(tabsOf(1)).toEqual(['shared', 'beta']);
    await userEvent.click(await screen.findByRole('button', { name: 'Add shared to favorites' }));
    await settle();
    reads.release();
    // The star went to this vault's file, read once it arrived: never the
    // first vault's text, which only an editor kept across the switch holds.
    await waitFor(() => expect(vault.written['shared.md']).toContain('favorite: true'));
    expect(vault.written['shared.md']).toContain('In B.');
    expect(vault.written['shared.md']).not.toContain('In A.');
    await userEvent.click(tabIn(1, 'shared'));
    expect(await screen.findByText('In B.')).toBeDefined();
  });

  it('writes a tab’s typing once as it hides, and its autosave stands down behind the other tab', async () => {
    const vault = await alphaThenBetaInTabs();
    await userEvent.click(tabIn(1, 'alpha'));
    const editor = await editorIn(pane(1), 'alpha');
    await settle();
    // The host takes its time: a write still in flight when the autosave would fire.
    const landings: (() => void)[] = [];
    const writes = vi.spyOn(vault.fs, 'writeTextFile').mockImplementation(
      ({ path, contents }) =>
        new Promise((resolve) => {
          landings.push(() => {
            vault.written[path] = contents;
            resolve(2);
          });
        }),
    );
    vi.useFakeTimers();
    try {
      act(() => typeInto(editor, 'Typed.'));
      // A plain DOM click: the fake clock would hold a user-event click waiting.
      await act(async () => void fireEvent.click(tabIn(1, 'beta')));
      await act(async () => void vi.advanceTimersByTime(3_000));
      expect(writes).toHaveBeenCalledTimes(1);
      await act(async () => landings.forEach((land) => land()));
      await act(async () => void vi.advanceTimersByTime(3_000));
      expect(writes).toHaveBeenCalledTimes(1);
      expect(vault.written['alpha.md']).toContain('Typed.');
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

/** What typing needs of TipTap's editor, which the ui package holds; the desktop app does not depend on it. */
interface Editor {
  readonly state: {
    readonly selection: { readonly from: number; readonly to: number };
    readonly tr: { insertText: (text: string, from: number, to: number) => unknown };
  };
  readonly view: {
    dispatch: (tr: unknown) => void;
    someProp: (
      name: 'handleTextInput',
      f: (
        handle: (
          view: unknown,
          from: number,
          to: number,
          text: string,
          deflt: () => unknown,
        ) => boolean | void,
      ) => boolean | void,
    ) => boolean | void | undefined;
  };
}

/** The live editor of the shown note in a pane: TipTap hangs it on its element. */
/*
 * Pages as tabs (docs/design/tab-model.md, PR B): each page reads its own
 * hooks in its container, so its data landing or changing draws the
 * container and not the window around it.
 */
describe('pages as tabs', () => {
  const pane = (which: 1 | 2) => screen.getByRole('region', { name: `Pane ${which}` });
  const aTurn = () => act(() => new Promise<void>((turn) => setTimeout(turn, 0)));
  /**
   * Waits until a turn of the event loop draws nothing, so the counts that
   * follow are the action's alone: a condition on React's work, not a wait
   * on the clock.
   */
  const untilQuiet = () =>
    waitFor(async () => {
      startCountingRenders();
      await aTurn();
      expect(stopCountingRenders().commits).toBe(0);
    });
  /**
   * What was drawn since counting began, kept until a turn draws nothing: an
   * action's draws and whatever they set going, late ones included.
   */
  async function drawnUntilQuiet(): Promise<Record<string, number>> {
    const drawn: Record<string, number> = {};
    await waitFor(async () => {
      await aTurn();
      const turn = stopCountingRenders();
      for (const [name, count] of Object.entries(turn.renders)) {
        drawn[name] = (drawn[name] ?? 0) + count;
      }
      startCountingRenders();
      expect(turn.commits).toBe(0);
    });
    stopCountingRenders();
    return drawn;
  }
  const oneNote = () =>
    fakeVault({
      remembered: location,
      directories: { '': [entry('recipes.md', 'file')] },
      files: { 'recipes.md': '# Recipes\n\nSourdough.\n' },
    });
  /** The app on `vault`, with an index that answers as `index` says. */
  const renderOn = (vault: ReturnType<typeof fakeVault>, index = fakeIndexPorts(vault)) =>
    render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={vault}
        notes={notesFor(vault)}
        index={index}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={activityIn(memoryActivityStore())}
        sync={noSync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );
  /** Runs a palette command by its label. */
  async function runCommand(label: string) {
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.type(await screen.findByLabelText('Search the vault'), label);
    await userEvent.click(await screen.findByRole('option', { name: new RegExp(`^${label}`) }));
  }

  it('opening Today draws its container as the day lands, and never the window, the shell or the frames', async () => {
    renderOn(oneNote());
    await screen.findByRole('treeitem', { name: 'recipes' });
    await untilQuiet();

    startCountingRenders();
    await runCommand('Today');
    await screen.findByRole('article', { name: 'Today' });
    // The day read and landed: the page says what it holds.
    await screen.findByText(/nothing needs you/);
    const renders = await drawnUntilQuiet();

    // Mounted, then drawn again as its read landed: the container is where the page's data lands.
    expect(renders.TodayContainer ?? 0).toBeGreaterThanOrEqual(2);
    expect(renders.AppWindow ?? 0).toBe(0);
    expect(renders.AppShell ?? 0).toBe(0);
    expect(renders.PaneFrame ?? 0).toBe(0);
  });

  it('deciding an Inbox row draws the Inbox container alone: not the window, the shell, the tree or the frames', async () => {
    const task = 'Inbox/Loose task.md';
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('Inbox', 'directory')], Inbox: [entry(task, 'file')] },
      files: { [task]: '---\ntype: task\n---\n# Loose task\n' },
    });
    const index = fakeIndexPorts(vault);
    // The index lists one task waiting, and counts it; every other read is empty.
    index.index.query = async (sql: string) =>
      sql.includes('"importStamped"')
        ? {
            columns: ['path', 'title', 'type', 'modified'],
            rows: [[task, 'Loose task', 'task', 1]],
            truncated: false,
          }
        : sql.includes('AS "total"')
          ? { columns: ['total'], rows: [[1]], truncated: false }
          : { columns: [], rows: [], truncated: false };
    renderOn(vault, index);
    // The sidebar's row counts it from the window's own read, with no Inbox page open.
    const inboxRow = await screen.findByRole('button', { name: /^Inbox/ });
    await waitFor(() => expect(inboxRow.textContent).toContain('1'));
    await userEvent.click(inboxRow);
    const row = await screen.findByRole('form', { name: 'Clarify Loose task' });
    await userEvent.selectOptions(
      within(row).getByRole('combobox', { name: 'Status of Loose task' }),
      'next-action',
    );
    await untilQuiet();

    // The write behind the row is held, so what is counted is the row leaving, not the index moving after.
    const reads = vault.holdReads();
    startCountingRenders();
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Clarify Loose task' })).toBeNull(),
    );
    const renders = await drawnUntilQuiet();
    reads.release();

    expect(renders.InboxContainer ?? 0).toBeGreaterThanOrEqual(1);
    expect(renders.AppWindow ?? 0).toBe(0);
    expect(renders.AppShell ?? 0).toBe(0);
    expect(renders.VaultTree ?? 0).toBe(0);
    expect(renders.PaneFrame ?? 0).toBe(0);
  });

  it('draws a type page in each pane on its own table, whichever type the other pane shows', async () => {
    const PERSON = '---\nname: person\nlabel: Person\nproperties:\n  email: text\n---\n';
    const BOOK = '---\nname: book\nlabel: Book\nproperties:\n  author: text\n---\n';
    renderOn(
      fakeVault({
        remembered: location,
        directories: {
          '': [entry('recipes.md', 'file')],
          '.atlas/types': [
            entry('.atlas/types/person.md', 'file'),
            entry('.atlas/types/book.md', 'file'),
          ],
        },
        files: {
          'recipes.md': '# Recipes\n',
          '.atlas/types/person.md': PERSON,
          '.atlas/types/book.md': BOOK,
        },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /^Person, / }));
    await screen.findByRole('article', { name: 'Person' });
    // Split (⇧⌘\): the focused pane is the new one, which then opens Book.
    await userEvent.keyboard('{Meta>}{Shift>}\\{/Shift}{/Meta}');
    await screen.findByRole('region', { name: 'Pane 2' });
    await userEvent.click(screen.getByRole('button', { name: /^Book, / }));

    expect(await within(pane(2)).findByRole('article', { name: 'Book' })).toBeDefined();
    expect(await within(pane(1)).findByRole('article', { name: 'Person' })).toBeDefined();
  });

  it('opens another type to be edited in the same tab, its editor in the right sidebar following the tab', async () => {
    const PERSON = '---\nname: person\nlabel: Person\nproperties:\n  email: text\n---\n';
    const BOOK = '---\nname: book\nlabel: Book\nproperties:\n  author: text\n---\n';
    renderOn(
      fakeVault({
        remembered: location,
        directories: {
          '': [entry('recipes.md', 'file')],
          '.atlas/types': [
            entry('.atlas/types/person.md', 'file'),
            entry('.atlas/types/book.md', 'file'),
          ],
        },
        files: {
          'recipes.md': '# Recipes\n',
          '.atlas/types/person.md': PERSON,
          '.atlas/types/book.md': BOOK,
        },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /^Person, / }));
    await screen.findByRole('article', { name: 'Person' });
    const editType = () => screen.getByRole('button', { name: 'Edit type' });
    expect(editType().getAttribute('aria-pressed')).toBe('false');

    // The palette's "Edit Book type" lands in the same tab, and the right sidebar edits Book.
    await runCommand('Edit Book type');
    await screen.findByRole('article', { name: 'Book' });
    await waitFor(() => expect(editType().getAttribute('aria-pressed')).toBe('true'));
    const typeName = () =>
      (screen.getByRole('textbox', { name: 'Name of this type' }) as HTMLInputElement).value;
    expect(typeName()).toBe('Book');
    // The page keeps its notes beside the editor.
    expect(await screen.findByRole('button', { name: 'New book' })).toBeDefined();

    // The window (jsdom's 1024px) had no room for the 340px editor beside the
    // left sidebar, so the sidebar made way, as it does for any ask (collapse.ts).
    await userEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    // Back to Person by a plain open: the aside, still on Type, edits what the tab shows.
    await userEvent.click(screen.getByRole('button', { name: /^Person, / }));
    await screen.findByRole('article', { name: 'Person' });
    await waitFor(() => expect(typeName()).toBe('Person'));
  });

  // #130 (#283): another vault opening with the Inbox open starts the page
  // afresh — its rows held back for that vault's own offers — rather than
  // keeping what the last vault's page had. The panes are keyed by the vault.
  it('starts the Inbox page afresh for another vault opened with the Inbox open', async () => {
    const other: VaultLocation = { absolutePath: '/Users/j/Other', name: 'Other' };
    const task = 'Inbox/Loose task.md';
    // A note loose at the root is what the tidy offers to move: its read is the offers' read.
    const files = { [task]: '---\ntype: task\n---\n# Loose task\n', 'loose.md': '# Loose\n' };
    const vault = fakeVault({
      remembered: location,
      directories: {
        '': [entry('Inbox', 'directory'), entry('loose.md', 'file')],
        Inbox: [entry(task, 'file')],
      },
      files,
      elsewhere: { [other.absolutePath]: files },
      picks: [other],
    });
    const index = fakeIndexPorts(vault);
    index.index.query = async (sql: string) =>
      sql.includes('"importStamped"')
        ? {
            columns: ['path', 'title', 'type', 'modified'],
            rows: [[task, 'Loose task', 'task', 1]],
            truncated: false,
          }
        : sql.includes('AS "total"')
          ? { columns: ['total'], rows: [[1]], truncated: false }
          : { columns: [], rows: [], truncated: false };
    renderOn(vault, index);
    await userEvent.click(await screen.findByRole('button', { name: /^Inbox/ }));
    const before = await screen.findByRole('article', { name: 'Inbox' });
    await within(before).findByRole('form', { name: 'Clarify Loose task' });
    // The other vault remembers the same tab, with the same id, on the Inbox.
    const remembered = window.localStorage.getItem(`atlas.workspace:${location.absolutePath}`);
    window.localStorage.setItem(
      `atlas.workspace:${other.absolutePath}`,
      (remembered ?? '').replace(location.absolutePath, other.absolutePath),
    );

    // The other vault's offers take their time to read: its tidy reads the loose
    // note, on its own. The index's reads, which carry every note, go through.
    const readNotes = vault.fs.readNotes;
    let holdingOffers: Promise<void> | null = null;
    let releaseOffers = () => {};
    vault.fs.readNotes = async (paths) => {
      const theTidys = paths.length === 1 && paths[0] === 'loose.md';
      if (theTidys && holdingOffers !== null) await holdingOffers;
      return readNotes(paths);
    };
    holdingOffers = new Promise<void>((resolve) => (releaseOffers = resolve));
    await userEvent.click(screen.getByRole('button', { name: 'Vault' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Open another folder…' }));
    expect(await screen.findByRole('button', { name: 'Other' })).toBeDefined();
    const after = await screen.findByRole('article', { name: 'Inbox' });
    // A page made afresh is a new one on the screen, not the first vault's kept,
    // and holds its rows — inert, so out of the accessibility tree: found by
    // their text — while this vault's offers are still being read.
    expect(after).not.toBe(before);
    const title = await within(after).findByText('Loose task');
    expect(title.closest('[inert]')).not.toBeNull();
    releaseOffers();
    await waitFor(() => expect(title.closest('[inert]')).toBeNull());
    expect(within(after).getByRole('form', { name: 'Clarify Loose task' })).toBeDefined();
  });

  it('a proposal answered in one vault: another vault lists its own, at the same path, with no undo', async () => {
    const other: VaultLocation = { absolutePath: '/Users/j/Other', name: 'Other' };
    const proposal = 'Inbox/Proposals/Call Tobias.md';
    const text = [
      '---',
      'type: proposal',
      'kind: task',
      'state: open',
      'payload:',
      '  title: Call Tobias',
      '  properties:',
      '    status: next-action',
      '---',
      '',
      'He asked on the call.',
      '',
    ].join('\n');
    const vault = fakeVault({
      remembered: location,
      directories: {
        '': [entry('Inbox', 'directory')],
        Inbox: [entry('Inbox/Proposals', 'directory')],
        'Inbox/Proposals': [entry(proposal, 'file')],
      },
      files: { [proposal]: text },
      elsewhere: { [other.absolutePath]: { [proposal]: text } },
      picks: [other],
    });
    // The fake's `readNotes` reads the first vault's files; `readTextFile` reads the open one's.
    vault.fs.readNotes = async (paths) => {
      const read = await Promise.all(
        paths.map((at) =>
          vault.fs.readTextFile(createVaultPath(at)).then(
            ({ text: body, modified }) => ({ path: at, text: body, modified, size: body.length }),
            () => null,
          ),
        ),
      );
      return read.filter((note) => note !== null);
    };
    renderOn(vault);
    // The sidebar counts the proposal; the Inbox lists it and accepts it.
    const inboxRow = await screen.findByRole('button', { name: /^Inbox/ });
    await waitFor(() => expect(inboxRow.textContent).toContain('1'));
    await userEvent.click(inboxRow);
    const inbox = await screen.findByRole('article', { name: 'Inbox' });
    await within(inbox).findByText('Call Tobias');
    await userEvent.click(within(inbox).getByRole('button', { name: 'Accept' }));
    // The accept's Undo is the window's toast's (slice 15), not the page's.
    await screen.findByRole('button', { name: 'Undo' });
    const remembered = window.localStorage.getItem(`atlas.workspace:${location.absolutePath}`);
    window.localStorage.setItem(
      `atlas.workspace:${other.absolutePath}`,
      (remembered ?? '').replace(location.absolutePath, other.absolutePath),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Vault' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Open another folder…' }));
    expect(await screen.findByRole('button', { name: 'Other' })).toBeDefined();
    const after = await screen.findByRole('article', { name: 'Inbox' });
    // The other vault's proposal, at the same path, is its own: listed, and nothing to take back.
    expect(await within(after).findByText('Call Tobias')).toBeDefined();
    expect(within(after).getByRole('button', { name: 'Accept' })).toBeDefined();
    // Nor in the window: the toast offering the first vault's Undo went as the other opened.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('the Inbox in both panes: a row decided in one leaves the other while its write is held', async () => {
    const task = 'Inbox/Loose task.md';
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry('Inbox', 'directory')], Inbox: [entry(task, 'file')] },
      files: { [task]: '---\ntype: task\n---\n# Loose task\n' },
    });
    const index = fakeIndexPorts(vault);
    index.index.query = async (sql: string) =>
      sql.includes('"importStamped"')
        ? {
            columns: ['path', 'title', 'type', 'modified'],
            rows: [[task, 'Loose task', 'task', 1]],
            truncated: false,
          }
        : sql.includes('AS "total"')
          ? { columns: ['total'], rows: [[1]], truncated: false }
          : { columns: [], rows: [], truncated: false };
    renderOn(vault, index);
    const inboxRow = await screen.findByRole('button', { name: /^Inbox/ });
    await waitFor(() => expect(inboxRow.textContent).toContain('1'));
    await userEvent.click(inboxRow);
    await within(pane(1)).findByRole('form', { name: 'Clarify Loose task' });
    // Split (⇧⌘\\): the new pane is focused, and the Inbox opens there too.
    await userEvent.keyboard('{Meta>}{Shift>}\\{/Shift}{/Meta}');
    await screen.findByRole('region', { name: 'Pane 2' });
    await userEvent.click(screen.getByRole('button', { name: /^Inbox/ }));
    const second = await within(pane(2)).findByRole('form', { name: 'Clarify Loose task' });
    const first = within(pane(1)).getByRole('form', { name: 'Clarify Loose task' });

    await userEvent.selectOptions(
      within(first).getByRole('combobox', { name: 'Status of Loose task' }),
      'next-action',
    );
    const reads = vault.holdReads();
    await userEvent.click(within(first).getByRole('button', { name: 'Save' }));
    // Gone from both panes while the write is held: the window's hold, not the tab's.
    await waitFor(() =>
      expect(within(pane(1)).queryByRole('form', { name: 'Clarify Loose task' })).toBeNull(),
    );
    await waitFor(() => expect(second.isConnected).toBe(false));
    expect(within(pane(2)).queryByRole('form', { name: 'Clarify Loose task' })).toBeNull();
    reads.release();
  });
});

describe('each pane reads what it shows, and nothing for a note saved elsewhere (#325)', () => {
  // jsdom lays nothing out, and ProseMirror measures the selection as panes open.
  beforeAll(() => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  });

  const pane = (which: 1 | 2) => screen.getByRole('region', { name: `Pane ${which}` });
  const aTurn = () => act(() => new Promise<void>((turn) => setTimeout(turn, 0)));
  const untilQuiet = () =>
    waitFor(async () => {
      startCountingRenders();
      await aTurn();
      expect(stopCountingRenders().commits).toBe(0);
    });
  /** What was drawn from now until a turn draws nothing. */
  async function drawnUntilQuiet(): Promise<Record<string, number>> {
    const drawn: Record<string, number> = {};
    await waitFor(async () => {
      await aTurn();
      const turn = stopCountingRenders();
      for (const [name, count] of Object.entries(turn.renders)) {
        drawn[name] = (drawn[name] ?? 0) + count;
      }
      startCountingRenders();
      expect(turn.commits).toBe(0);
    });
    stopCountingRenders();
    return drawn;
  }

  /**
   * A vault another program edits, watched, on an index held in memory: each
   * edit is a new text and a new time, told to the window as the watcher
   * tells it. The index's calls are counted; a sync ends by counting its notes.
   */
  function editedVault(files: Record<string, string>) {
    const times = new Map<string, number>();
    const timeOf = (path: string) => times.get(path) ?? 1;
    const base = fakeVault({
      remembered: location,
      directories: { '': Object.keys(files).map((path) => entry(path, 'file')) },
      files,
    });
    const heard: ((paths: readonly string[]) => void)[] = [];
    const fs: VaultFsPort = {
      ...base.fs,
      listFiles: async () => [],
      listNotes: async (options) =>
        (await base.fs.listNotes(options)).map((note) => ({
          ...note,
          modified: timeOf(note.path),
        })),
      readNotes: async (paths) =>
        (await base.fs.readNotes(paths)).map((note) => ({ ...note, modified: timeOf(note.path) })),
      readTextFile: async (path) => ({
        ...(await base.fs.readTextFile(path)),
        modified: timeOf(path),
      }),
    };
    const watch = {
      start: async () => {},
      onChange: async (handler: (paths: readonly string[]) => void) => {
        heard.push(handler);
        return () => {};
      },
    };
    const vault = { ...base, fs, watch };
    const memory = memoryIndexPort();
    const calls = { manifest: 0, syncs: 0, today: 0 };
    const index: IndexPorts = {
      fs,
      markdown: remarkMarkdown,
      index: {
        ...memory,
        manifest: async () => {
          calls.manifest += 1;
          return memory.manifest();
        },
        query: async (sql, parameters) => {
          if (sql.includes('/* weekly review: tasks */')) calls.today += 1;
          // What the memory index cannot answer is answered as nothing found, as
          // an index with none of it would: no reader here fails, to be read again.
          return memory
            .query(sql, parameters)
            .catch(() => ({ columns: [], rows: [], truncated: false }));
        },
        stats: async () => {
          calls.syncs += 1;
          return memory.stats();
        },
      },
    };
    /** Another program writes `path`; the watcher says so; the sync it sets off settles. */
    const edit = async (path: string, text: string) => {
      const syncs = calls.syncs;
      files[path] = text;
      times.set(path, timeOf(path) + 1);
      await act(() => heard.forEach((handler) => handler([path])));
      await waitFor(() => expect(calls.syncs).toBeGreaterThan(syncs));
    };
    const ready = async () => {
      await waitFor(() => expect(heard.length).toBeGreaterThan(0));
      await waitFor(() => expect(calls.syncs).toBeGreaterThan(0));
    };
    return { vault, index, calls, edit, ready };
  }

  const renderOn = ({ vault, index }: ReturnType<typeof editedVault>) =>
    render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={vault}
        notes={notesFor(vault)}
        index={index}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={activityIn(memoryActivityStore())}
        sync={noSync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );

  /** `first` in pane 1 and `second` in pane 2, each settled. */
  async function twoPanes(edited: ReturnType<typeof editedVault>, first: string, second: string) {
    renderOn(edited);
    await edited.ready();
    await userEvent.click(await screen.findByRole('treeitem', { name: first }));
    await screen.findByRole('article', { name: first });
    await userEvent.keyboard('{Meta>}{Shift>}\\{/Shift}{/Meta}');
    await screen.findByRole('region', { name: 'Pane 2' });
    await userEvent.click(screen.getByRole('treeitem', { name: second }));
    await within(pane(2)).findByRole('article', { name: second });
    await within(pane(1)).findByRole('article', { name: first });
    await untilQuiet();
  }

  const NOTES = () => ({
    'alpha.md': '# alpha\n\nAlpha.\n',
    'beta.md': '# beta\n\n![[delta#^d1]]\n',
    'gamma.md': '# gamma\n\nGamma.\n',
    'delta.md': '# delta\n\nDelta. ^d1\n',
  });

  it('draws neither pane, and asks nothing for them, for an edit to a note neither shows', async () => {
    const edited = editedVault(NOTES());
    await twoPanes(edited, 'alpha', 'beta');
    const before = { ...edited.calls };

    startCountingRenders();
    await edited.edit('gamma.md', '# gamma\n\nGamma, edited by another program.\n');
    const renders = await drawnUntilQuiet();

    expect(renders.NotePaneContainer ?? 0).toBe(0);
    // The tree listed the same notes again: its rows keep their lists, and draw nothing.
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
    expect(renders.VaultTreeRow ?? 0).toBe(0);
    // The sync's own look at the index, and no reader's: the embed in pane 2
    // asks for the manifest each time it reads its block.
    expect(edited.calls.syncs - before.syncs).toBe(1);
    expect(edited.calls.manifest - before.manifest).toBe(edited.calls.syncs - before.syncs);
  });

  it('shows in the pane an outside edit to the note it shows, and to the note it embeds', async () => {
    const edited = editedVault(NOTES());
    await twoPanes(edited, 'alpha', 'beta');
    const article = within(pane(2)).getByRole('article', { name: 'beta' });
    const shown = () => within(article).getByLabelText('Embedded block', { exact: true });
    await waitFor(() => expect(shown().textContent).toBe('Delta.'));

    await edited.edit('delta.md', '# delta\n\nDelta, edited by another program. ^d1\n');
    await waitFor(() => expect(shown().textContent).toBe('Delta, edited by another program.'));

    await edited.edit('beta.md', '# beta\n\n![[delta#^d1]]\n\nAnd now this.\n');
    await waitFor(() => expect(article.textContent).toContain('And now this'));
    expect(within(pane(1)).getByRole('article', { name: 'alpha' }).textContent).toContain('Alpha.');
  });

  it('reads Today again for a task changed, and not for a note saved elsewhere', async () => {
    const edited = editedVault({
      ...NOTES(),
      'Ship the page.md': '---\ntype: task\nstatus: next-action\n---\n# Ship the page\n',
    });
    renderOn(edited);
    await edited.ready();
    await userEvent.click(await screen.findByRole('treeitem', { name: 'alpha' }));
    await screen.findByRole('article', { name: 'alpha' });
    await userEvent.keyboard('{Meta>}{Shift>}\\{/Shift}{/Meta}');
    await screen.findByRole('region', { name: 'Pane 2' });
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.type(await screen.findByLabelText('Search the vault'), 'Today');
    await userEvent.click(await screen.findByRole('option', { name: /^Today/ }));
    await within(pane(2)).findByRole('article', { name: 'Today' });
    await waitFor(() => expect(edited.calls.today).toBeGreaterThan(0));
    await untilQuiet();
    const read = edited.calls.today;

    startCountingRenders();
    await edited.edit('gamma.md', '# gamma\n\nGamma, edited.\n');
    const renders = await drawnUntilQuiet();
    expect(renders.TodayContainer ?? 0).toBe(0);
    expect(edited.calls.today).toBe(read);

    await edited.edit(
      'Ship the page.md',
      '---\ntype: task\nstatus: in-progress\n---\n# Ship the page\n',
    );
    await waitFor(() => expect(edited.calls.today).toBe(read + 1));
    await untilQuiet();
    expect(edited.calls.today).toBe(read + 1);
  });
});

/*
 * Regressions found in PR #534 (verification pass on 510eced0): a comment typed
 * in a highlight's field and not yet left is the person's work as much as the
 * note's own typing. It is written, over the comment it started from, when every
 * pane's work is — as the window closes here; before another vault opens in
 * e2e/highlight-node.regressions-534.spec.ts, whose host moves to the next
 * vault only once the last is settled, as Tauri's does (this fake's picker
 * moves it as the folder is picked).
 */
describe("a highlight's comment typed, then the window closed (#534)", () => {
  const BOOK = 'Brightwater.md';
  const MARKER =
    '<!-- atlas:highlight {"v":1,"mark":"underline","color":"pink","kind":"kindle","location":41,"locationEnd":44} -->';
  const TEXT = [
    '---',
    'type: literature',
    'kind: kindle',
    'title: "Brightwater"',
    'author: "Tobias Fenn"',
    '---',
    'My own paragraph.',
    '',
    '> The tide keeps its own hours.',
    `> ${MARKER}`,
    '>',
    '> Lit by Mara.',
    '',
    '^kd0041',
    '',
  ].join('\n');
  /** The window's close, pressed by the test: the stages the app registered run, as the host runs them. */
  function closeButton() {
    const tasks: (() => Promise<void>)[] = [];
    const closing: WindowClosingPort = {
      beforeClose: async (task) => {
        tasks.push(task);
        return () => void tasks.splice(tasks.indexOf(task), 1);
      },
    };
    const press = async () => {
      for (const task of [...tasks]) await task();
    };
    return { closing, press };
  }

  function renderBook(closing: WindowClosingPort) {
    const files = { [BOOK]: TEXT };
    const vault = fakeVault({
      remembered: location,
      directories: { '': [entry(BOOK, 'file')] },
      files,
    });
    render(
      <App
        offered={EVERY_ENTRY_POINT}
        appInfo={appInfo}
        vault={vault}
        notes={notesFor(vault)}
        index={fakeIndexPorts(vault)}
        sources={sources}
        links={{ open: async () => {} }}
        snapshot={{ capture: () => Promise.reject(new Error('no pictures in these tests')) }}
        api={api}
        chat={chat}
        activity={{ store: memoryActivityStore(), closing }}
        sync={noSync}
        googleCalendar={googleCalendar}
        granola={granola}
        slack={slack}
        globalCapture={fakeGlobalCapture().ports}
      />,
    );
    return { files };
  }

  /** Types in the comment field and stays in it: no blur, so nothing but the close writes it. */
  async function typeComment(words: string) {
    await userEvent.click(await screen.findByRole('treeitem', { name: 'Brightwater' }));
    const field = await screen.findByRole('textbox', { name: 'Comment on this highlight' });
    act(() => {
      field.focus();
      fireEvent.change(field, { target: { value: words } });
    });
  }

  it('is written as the window closes', async () => {
    const close = closeButton();
    const { files } = renderBook(close.closing);
    await typeComment('Typed, then the window closed.');
    await act(async () => {
      await close.press();
    });
    expect(files[BOOK]).toContain('> Typed, then the window closed.');
    expect(files[BOOK]).not.toContain('Lit by Mara.');
  });

  /*
   * Regression (#534, found on f4c54b6b): comments kept from the last close are
   * offered back through `offered`, read while the pane renders; the store is
   * read into memory only in an effect after it. A pane drawn as the vault
   * opens — the tab DFAI restores at start — asks before they are read, and
   * its answer is memoised, so the field never gets them back.
   */
  const KEPT = 'Kept from the last close.';
  function keepComment() {
    window.localStorage.setItem(
      `atlas.stranded-comments:${JSON.stringify(location.absolutePath)}:${BOOK}`,
      JSON.stringify({
        path: BOOK,
        comments: [{ id: 'kd0041', comment: KEPT, base: 'Lit by Mara.' }],
        reason: 'It was not written.',
        keptAt: Date.now(),
      }),
    );
  }
  const commentField = async () =>
    (await screen.findByRole('textbox', {
      name: 'Comment on this highlight',
    })) as HTMLTextAreaElement;

  it('puts a kept comment back in its field when the note is opened again', async () => {
    keepComment();
    renderBook(closeButton().closing);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'Brightwater' }));
    await waitFor(async () => expect((await commentField()).value).toBe(KEPT));
  });

  it('puts a kept comment back in its field when its tab is restored at start', async () => {
    renderBook(closeButton().closing);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'Brightwater' }));
    await commentField();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    // DFAI quits with the note's tab open, its comment kept; then starts again.
    cleanup();
    keepComment();
    renderBook(closeButton().closing);
    // The kept comment was read: the notice tells of it.
    expect(await screen.findByText(new RegExp(KEPT))).toBeDefined();
    await waitFor(async () => expect((await commentField()).value).toBe(KEPT));
  });

  it('does not let go of a kept comment its restored tab has not written', async () => {
    renderBook(closeButton().closing);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'Brightwater' }));
    await commentField();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    cleanup();
    keepComment();
    const { files } = renderBook(closeButton().closing);
    expect(await screen.findByText(new RegExp(KEPT))).toBeDefined();
    await commentField();
    // The note closes with nothing typed in it: the kept comment is let go of only once written.
    cleanup();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const stored = window.localStorage.getItem(
      `atlas.stranded-comments:${JSON.stringify(location.absolutePath)}:${BOOK}`,
    );
    expect(`${files[BOOK]}\n${stored ?? ''}`).toContain(KEPT);
  });
});

async function editorIn(region: HTMLElement, title: string): Promise<Editor> {
  const article = await within(region).findByRole('article', { name: title });
  const element = await waitFor(() => {
    const found = article.querySelector('.ProseMirror');
    if (found === null) throw new Error('no editor yet');
    return found;
  });
  return (element as HTMLElement & { editor: Editor }).editor;
}

/** Types as a person does, one character at a time through the editor's own input handling. */
function typeInto(instance: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = instance.state.selection;
    const handled = instance.view.someProp('handleTextInput', (handle) =>
      handle(instance.view, from, to, char, () => instance.state.tr.insertText(char, from, to)),
    );
    if (handled !== true) instance.view.dispatch(instance.state.tr.insertText(char, from, to));
  }
}
