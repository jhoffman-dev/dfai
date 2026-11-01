// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  activeTabOf,
  createVaultPath,
  EMPTY_WORKSPACE,
  NO_LINKS,
  openInActiveTab,
  type EditorDocument,
  type PropertyDef,
} from '@dfai/domain';
import type { PropertyRow } from '@dfai/ui';
import { startCountingRenders, stopCountingRenders } from '@dfai/ui/testing';
import { createOverlayStore } from '../overlay-store.ts';
import { createRevealStore } from '../panes/reveals.ts';
import { createWorkspaceStore, loadVault, workspaceNow } from '../workspace/workspace-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { WorkspaceStoresProvider } from '../workspace/workspace-wiring.tsx';
import { AsideContainer } from './aside-container.tsx';
import { createAsideStore, showAsideTab } from './aside-store.ts';
import { ClaudeSeatProvider } from './claude-seat.tsx';
import type { RowPorts } from './row-aside.tsx';
import { createShownNotes, publishShownDoc, publishShownNote } from './shown-notes.ts';

await vi.hoisted(async () => {
  const { installRenderCounter } = await import('@dfai/ui/testing');
  installRenderCounter();
});

afterEach(cleanup);

const NOTE = createVaultPath('Tasks/Ship it.md');

const row = (key: string): PropertyRow => ({
  def: {
    key,
    kind: 'text',
    label: key,
    required: false,
    options: [],
    target: null,
    many: false,
  } satisfies PropertyDef,
  value: 'Mara Quill',
  error: null,
});

const typed = (count: number): EditorDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(count) }] }],
});

describe('what a keystroke draws in the aside (#387 review)', () => {
  it('with the aside open on Properties, ten keystrokes draw no PropertiesPanel and no row', () => {
    const store = createWorkspaceStore({
      remembered: {
        read: () => openInActiveTab(EMPTY_WORKSPACE, { kind: 'note', path: NOTE }),
        write: () => {},
      },
    });
    loadVault(store, '/v');
    const tab = activeTabOf(workspaceNow(store)).id;
    const aside = createAsideStore({ remembered: { read: () => null, write: () => {} } });
    showAsideTab(aside, 'properties');
    const shown = createShownNotes();
    publishShownNote(shown, tab, {
      path: NOTE,
      title: 'Ship it',
      kicker: 'Task',
      panel: {
        typeName: 'task',
        rows: [row('owner'), row('status')],
        relationChoices: {},
        onChange: () => {},
      },
      links: NO_LINKS,
      mentions: { kind: 'idle' },
      onFindMentions: () => {},
      onLinkMention: () => {},
    });
    publishShownDoc(shown, tab, typed(0));
    render(
      <WorkspaceStoresProvider
        value={{
          store,
          aside,
          shown,
          reveals: createRevealStore(),
          overlays: createOverlayStore(),
          nameOf: () => 'Ship it',
        }}
      >
        <ClaudeSeatProvider value={null}>
          <AsideContainer
            rows={{ pane: { types: [], savedViews: [] } } as unknown as RowPorts}
            types={{ onDelete: () => {}, onEditTemplate: () => {}, onOpenType: () => {} }}
          />
        </ClaudeSeatProvider>
      </WorkspaceStoresProvider>,
      { wrapper: queryWrapper().wrapper },
    );
    expect(screen.getByRole('textbox', { name: 'owner' })).toBeDefined();

    // Each keystroke: the tab publishes a new document and nothing else.
    startCountingRenders();
    for (let key = 1; key <= 10; key += 1) {
      act(() => publishShownDoc(shown, tab, typed(key)));
    }
    const { renders } = stopCountingRenders();
    expect(renders['PropertiesPanel'] ?? 0).toBe(0);
    expect(renders['PropertiesPane'] ?? 0).toBe(0);
    expect(renders['AsideContainer'] ?? 0).toBe(0);
  });
});
