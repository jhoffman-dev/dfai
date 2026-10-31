// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { NoteChange, ObjectType } from '@dfai/domain';
import type { IndexPort } from '@dfai/application';
import { ArchiveContainer } from '../archive/archive-container.tsx';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { TermsContainer } from '../terms/terms-container.tsx';
import { TypeContainer } from '../types/type-container.tsx';
import { createAsideStore } from '../aside/aside-store.ts';
import { createRevealStore } from '../panes/reveals.ts';
import { createShownNotes } from '../aside/shown-notes.ts';
import { createOverlayStore } from '../overlay-store.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { createWorkspaceStore, loadVault } from '../workspace/workspace-store.ts';
import { WorkspaceStoresProvider } from '../workspace/workspace-wiring.tsx';
import { queryWrapper } from './query-wrapper.tsx';
import { createReadInvalidator } from './read-invalidator.ts';
import { useScopedIndexKey } from './use-scoped-index-key.ts';

/**
 * Attack on PR #424 (#327). Before it, the Archive, the Terms page and a
 * type's table read again on every news of the index, so a read of theirs that
 * failed (the index busy, a type's view not yet rebuilt) was tried again on
 * the index's next news, whatever it was about. The read invalidator keeps
 * that promise for the reads it holds ("a pane read whose last read failed is
 * read again on any news, touched or not", #259, #325) — but these pages read
 * in their own effects, keyed on a scoped key that never fails, so the
 * promise no longer reaches them: a failed read now waits for news of its own
 * scope, which may never come.
 */

vi.mock('../pages-on-first-use.ts', () => {
  const screen = () => ({ Component: () => null });
  return {
    archivePage: screen(),
    tagsScreen: screen(),
    termsPage: screen(),
    automationsScreen: screen(),
    queryScreen: screen(),
    typePage: screen(),
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

/** An index whose queries fail while `failing` is set (a busy or locked index), and count. */
function flakyIndex() {
  const state = { failing: true, queries: 0 };
  const index = new Proxy(
    {},
    {
      get: (_, name: string) => async () => {
        if (name !== 'query') return [];
        state.queries += 1;
        if (state.failing) throw new Error('database is locked');
        return { columns: [], rows: [], truncated: false };
      },
    },
  ) as IndexPort;
  return { index, state };
}

function newsOf() {
  const status = createIndexStatusStore();
  status.setState({ vault: VAULT, phase: 'ready', revision: 1 });
  const { client, wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
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
  const tell = async (changes: NoteChange[]) => {
    const was = sentinel.result.current;
    act(() => {
      reads.noteChanges(VAULT, changes);
      status.setState({ revision: status.getState().revision + 1 });
      reads.indexMoved(VAULT, true);
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

function wiringOf(status: ReturnType<typeof newsOf>['status'], index: IndexPort) {
  return {
    pages: {
      ports: { index, fs: {} },
      openNote: noop,
      openPage: noop,
      terms: { templates: [] },
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

/** A note saved that none of these pages is made from. */
const ELSEWHERE = edited('Notes/Sourdough.md');

const PAGES: readonly {
  name: string;
  page: (wiring: PageContainerProps['wiring']) => ReactElement;
}[] = [
  {
    name: 'the Archive',
    page: (wiring) => <ArchiveContainer wiring={wiring} tabId={tabId} chrome={chrome} />,
  },
  {
    name: 'the Terms page',
    page: (wiring) => <TermsContainer wiring={wiring} tabId={tabId} chrome={chrome} />,
  },
  {
    name: 'a type’s table',
    page: (wiring) => <TypeContainer wiring={wiring} tabId={tabId} chrome={chrome} name="task" />,
  },
];

describe.each(PAGES)('attack-424: $name after a read that failed', ({ page }) => {
  it('reads again on the index’s next news, touched or not, as a failed read of the invalidator does', async () => {
    const news = newsOf();
    const { index, state } = flakyIndex();
    render(
      <WorkspaceStoresProvider value={storesProvider()}>
        {page(wiringOf(news.status, index))}
      </WorkspaceStoresProvider>,
      { wrapper: news.wrapper },
    );
    await waitFor(() => expect(state.queries).toBeGreaterThan(0));
    await news.turns();
    const failedReads = state.queries;

    // The index is answering again; a note elsewhere is saved, and the index has news.
    state.failing = false;
    await news.tell([ELSEWHERE]);

    expect(state.queries).toBeGreaterThan(failedReads);
  });
});
