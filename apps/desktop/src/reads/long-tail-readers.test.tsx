// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { NoteChange, ObjectType } from '@dfai/domain';
import type { IndexPort } from '@dfai/application';
import { ArchiveContainer } from '../archive/archive-container.tsx';
import { AutomationsContainer } from '../automations/automations-container.tsx';
import { createAutomationsStore, publishAutomations } from '../automations/automations-store.ts';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { createMeetingSetupStore } from '../meetings/use-meeting-setup.ts';
import { changePalette, createOverlayStore, showOverlay } from '../overlay-store.ts';
import { QueryContainer } from '../query/query-container.tsx';
import { createQueryTextStore } from '../query/query-text-store.ts';
import { SearchPaletteSlot } from '../search-palette-slot.tsx';
import { TagsContainer } from '../tags/tags-container.tsx';
import { TermsContainer } from '../terms/terms-container.tsx';
import { TypeContainer } from '../types/type-container.tsx';
import { createAsideStore } from '../aside/aside-store.ts';
import { createRevealStore } from '../panes/reveals.ts';
import { createShownNotes } from '../aside/shown-notes.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { createWorkspaceStore, loadVault } from '../workspace/workspace-store.ts';
import { WorkspaceStoresProvider } from '../workspace/workspace-wiring.tsx';
import { queryWrapper } from './query-wrapper.tsx';
import { createReadInvalidator } from './read-invalidator.ts';
import { useScopedIndexKey } from './use-scoped-index-key.ts';

/**
 * Performance 11 (#327): the pages that read again on every news of the index
 * read on a key of their own scope. Each is drawn as the window draws it, and
 * told news as the index tells it; what it reads is counted. The pages
 * themselves are left out (they are drawn from what was read).
 */

/** The key each page's screen was handed, by page, for the screens that read on it themselves. */
const handed = vi.hoisted(() => new Map<string, Set<string>>());

vi.mock('../pages-on-first-use.ts', () => {
  const screen = (name: string) => ({
    Component: ({ indexKey }: { indexKey?: string }) => {
      if (indexKey !== undefined) handed.set(name, (handed.get(name) ?? new Set()).add(indexKey));
      return null;
    },
  });
  return {
    archivePage: screen('archive'),
    tagsScreen: screen('tags'),
    termsPage: screen('terms'),
    automationsScreen: screen('rule-editor'),
    queryScreen: screen('query'),
    typePage: screen('type'),
  };
});

const VAULT = '/v';

const edited = (path: string, type: string | null = null): NoteChange => ({
  kind: 'changed',
  path,
  type,
  digest: 'b',
  before: 'a',
});

/** An index that answers every ask with nothing found, and counts the reads. */
function countingIndex() {
  const calls = { query: 0, search: 0 };
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    query: () => {
      calls.query += 1;
      return { columns: [], rows: [], truncated: false };
    },
    search: () => {
      calls.search += 1;
      return [];
    },
  };
  // A Proxy: the pages ask the port for more than these two, and nothing else matters here.
  const index = new Proxy(
    {},
    {
      get:
        (_, name: string) =>
        async (...args: unknown[]) =>
          answers[name]?.(...args) ?? [],
    },
  ) as IndexPort;
  return { index, calls };
}

/** A ready index of the vault, its reads, and the news the index tells them. */
function newsOf() {
  const status = createIndexStatusStore();
  status.setState({ vault: VAULT, phase: 'ready', revision: 1 });
  const { client, wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
  // A reader any note moves: once it has moved, the news has reached every reader it touched.
  const sentinel = renderHook(
    () =>
      useScopedIndexKey({ status, vault: VAULT, reader: ['sentinel'], scope: { anyNote: true } }),
    { wrapper },
  );
  const turns = async () => {
    for (let turn = 0; turn < 3; turn += 1) {
      await act(() => new Promise((next) => setTimeout(next, 0)));
    }
  };
  /** The index settles once more, having heard `changes` (null: a build, whose notes are not told). */
  const tell = async (changes: NoteChange[] | null) => {
    const was = sentinel.result.current;
    act(() => {
      if (changes !== null) reads.noteChanges(VAULT, changes);
      status.setState({ revision: status.getState().revision + 1 });
      reads.indexMoved(VAULT, changes !== null);
    });
    await waitFor(() => expect(sentinel.result.current).not.toBe(was));
    await turns();
  };
  return { status, wrapper, tell, turns };
}

const TASK: ObjectType = { name: 'task', label: 'Task', properties: [] } as unknown as ObjectType;

const noop = () => {};
const chrome = {} as PageContainerProps['chrome'];
const tabId = 'tab-1' as PageContainerProps['tabId'];

/** What every page is handed, as far as these pages read it. */
function wiringOf(status: ReturnType<typeof newsOf>['status'], index: IndexPort) {
  const automations = createAutomationsStore();
  // The rule editor is drawn once its runner has said where the rules stand.
  publishAutomations(automations, {} as Parameters<typeof publishAutomations>[1]);
  return {
    pages: {
      ports: { index, fs: {} },
      openNote: noop,
      openPage: noop,
      terms: { templates: [] },
      tags: { tags: { kind: 'ready', counts: [] }, renames: {} },
      automations: {
        store: automations,
        ports: {},
        setup: { store: createMeetingSetupStore(), automations },
      },
      query: { text: createQueryTextStore() },
      type: { onEditType: noop, onNewNote: noop, onEditTemplate: noop },
    },
    pane: {
      indexStatus: status,
      vault: VAULT,
      index,
      notes: { markdown: {} },
      editors: {},
      types: [TASK],
      notePaths: [],
      onChanged: noop,
      onTypeSaved: noop,
      activity: { record: noop, inOpenVault: noop },
      archive: { unarchive: async () => ({}), busy: false },
      savedViews: [],
      viewPaths: [],
      dashboards: [],
      typeTabs: () => undefined,
    },
    overlays: createOverlayStore(),
  } as unknown as PageContainerProps['wiring'];
}

function storesProvider() {
  const store = createWorkspaceStore({ remembered: { read: () => null, write: noop } });
  loadVault(store, VAULT);
  return {
    store,
    aside: createAsideStore({ remembered: { read: () => null, write: noop } }),
    shown: createShownNotes(),
    reveals: createRevealStore(),
    overlays: createOverlayStore(),
    nameOf: () => '',
  };
}

/** One page drawn on the news, and how many times it has read. */
async function drawn(page: (wiring: PageContainerProps['wiring']) => ReactElement, reads: Reads) {
  handed.clear();
  const news = newsOf();
  const { index, calls } = countingIndex();
  const wiring = wiringOf(news.status, index);
  render(
    <WorkspaceStoresProvider value={storesProvider()}>{page(wiring)}</WorkspaceStoresProvider>,
    { wrapper: news.wrapper },
  );
  const read = () => reads(calls);
  // What the page reads as it settles (a type's table reads twice: its sort starts afresh).
  await waitFor(() => expect(read()).toBeGreaterThan(0));
  await news.turns();
  return { ...news, read, settled: read() };
}

type Reads = (calls: ReturnType<typeof countingIndex>['calls']) => number;
const queried: Reads = (calls) => calls.query;
const searched: Reads = (calls) => calls.search;
/** A screen that reads on its key itself: each key it was handed is a read. */
const keysHanded =
  (name: string): Reads =>
  () =>
    handed.get(name)?.size ?? 0;

interface Reader {
  readonly name: string;
  readonly page: (wiring: PageContainerProps['wiring']) => ReactElement;
  readonly reads: Reads;
  /** Changes in what it is made from: each reads it again. */
  readonly within: readonly NoteChange[];
  /** Changes outside it: none reads it again. Empty for a reader of the whole vault. */
  readonly outside: readonly NoteChange[];
}

/** The palette up, with `query` typed. */
function paletteUp(query: string) {
  const store = createOverlayStore();
  showOverlay(store, 'search');
  changePalette(store, (input) => ({ ...input, query }));
  return store;
}

const palette = (wiring: PageContainerProps['wiring'], store: ReturnType<typeof paletteUp>) => (
  <SearchPaletteSlot
    store={store}
    workspace={createWorkspaceStore({ remembered: { read: () => null, write: noop } })}
    index={wiring.pane.index}
    commandsFor={() => []}
    offerFor={() => []}
    indexStatus={wiring.pane.indexStatus}
    vault={VAULT}
    onCommand={noop}
    onPick={noop}
    fallbackFocus={() => null}
  />
);

const PLAIN = edited('Notes/Sourdough.md');

const READERS: readonly Reader[] = [
  {
    name: 'the Archive',
    page: (wiring) => <ArchiveContainer wiring={wiring} tabId={tabId} chrome={chrome} />,
    reads: queried,
    within: [edited('Archive/Old plan.md'), edited('Projects/Garden.md', 'project')],
    outside: [PLAIN, edited('Tasks/Call the bank.md', 'task')],
  },
  {
    name: 'the Terms page',
    page: (wiring) => <TermsContainer wiring={wiring} tabId={tabId} chrome={chrome} />,
    reads: queried,
    within: [
      edited('Terms/Kubernetes.md', 'term'),
      edited('People/Ada.md', 'person'),
      edited('Companies/Acme.md', 'company'),
    ],
    outside: [PLAIN, edited('Tasks/Call the bank.md', 'task')],
  },
  {
    name: 'a type’s table',
    page: (wiring) => <TypeContainer wiring={wiring} tabId={tabId} chrome={chrome} name="task" />,
    reads: queried,
    within: [edited('Tasks/Call the bank.md', 'task'), edited('.atlas/types/task.md')],
    outside: [PLAIN, edited('Projects/Garden.md', 'project')],
  },
  {
    name: 'the tags page',
    page: (wiring) => (
      <TagsContainer wiring={wiring} tabId={tabId} chrome={chrome} selected="garden" />
    ),
    reads: keysHanded('tags'),
    within: [PLAIN],
    outside: [],
  },
  {
    name: 'the query page',
    page: (wiring) => <QueryContainer wiring={wiring} tabId={tabId} chrome={chrome} />,
    reads: queried,
    within: [PLAIN, edited('.atlas/types/task.md')],
    outside: [],
  },
  {
    name: 'the rule editor',
    page: (wiring) => <AutomationsContainer wiring={wiring} tabId={tabId} chrome={chrome} />,
    reads: keysHanded('rule-editor'),
    within: [PLAIN],
    outside: [],
  },
  {
    name: 'the search palette',
    page: (wiring) => palette(wiring, paletteUp('sourdough')),
    reads: searched,
    within: [PLAIN],
    outside: [],
  },
];

describe.each(READERS)('$name reads on a key of its own scope (#327)', (reader) => {
  it.each(reader.within.map((change) => [change.path, change] as const))(
    'reads again for news of %s, which it is made from',
    async (_, change) => {
      const page = await drawn(reader.page, reader.reads);
      await page.tell([change]);
      await waitFor(() => expect(page.read()).toBeGreaterThan(page.settled));
    },
  );

  it('reads again for news whose notes are not known: a build, a failure', async () => {
    const page = await drawn(reader.page, reader.reads);
    await page.tell(null);
    await waitFor(() => expect(page.read()).toBeGreaterThan(page.settled));
  });

  if (reader.outside.length > 0) {
    it('does not read again for news of a note it is not made from', async () => {
      const page = await drawn(reader.page, reader.reads);
      for (const change of reader.outside) await page.tell([change]);
      expect(page.read()).toBe(page.settled);
    });
  }
});

describe('the search palette while the index is rebuilt (#327)', () => {
  it('searches nothing typed until the build is done, then searches it', async () => {
    const store = paletteUp('sourdough');
    const page = await drawn((wiring) => palette(wiring, store), searched);
    act(() => page.status.setState({ phase: 'building' }));
    act(() => changePalette(store, (input) => ({ ...input, query: 'sourdough bread' })));
    await page.turns();
    expect(page.read()).toBe(page.settled);

    act(() => page.status.setState({ phase: 'ready' }));
    await page.tell(null);
    await waitFor(() => expect(page.read()).toBeGreaterThan(page.settled));
  });
});
