// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath } from '@dfai/domain';
import { fakeIndexPort } from '@dfai/application';
import { createOverlayStore, overlayNow, showOverlay } from './overlay-store.ts';
import { createWorkspaceStore } from './workspace/workspace-store.ts';
import { SearchPaletteSlot } from './search-palette-slot.tsx';
import { createIndexStatusStore } from './index/index-status-store.ts';
import { queryWrapper } from './reads/query-wrapper.tsx';
import { createReadInvalidator } from './reads/read-invalidator.ts';

const RECIPES = { path: createVaultPath('recipes.md'), title: 'Recipes', snippet: 'Sourdough' };
const NEW_VIEW = { id: 'new-view', label: 'New view' };

function slot() {
  const store = createOverlayStore();
  const onCommand = vi.fn();
  const onPick = vi.fn();
  const status = createIndexStatusStore();
  status.setState({ vault: '/vault', phase: 'ready', revision: 1 });
  const search = vi.fn(async () => [RECIPES]);
  const { client, wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
  render(
    <SearchPaletteSlot
      store={store}
      workspace={createWorkspaceStore({ remembered: { read: () => null, write: () => {} } })}
      index={fakeIndexPort({ search })}
      commandsFor={() => [NEW_VIEW]}
      offerFor={() => []}
      indexStatus={status}
      vault="/vault"
      onCommand={onCommand}
      onPick={onPick}
      fallbackFocus={() => null}
    />,
    { wrapper },
  );
  return { store, onCommand, onPick, status, reads, search };
}

const palette = () => screen.queryByRole('dialog', { name: 'Search notes' });

describe('the search palette slot', () => {
  it('draws nothing until ⌘K puts the palette up', async () => {
    const { store } = slot();
    expect(palette()).toBeNull();
    act(() => showOverlay(store, 'search'));
    expect(await screen.findByRole('dialog', { name: 'Search notes' })).toBeDefined();
  });

  it('opens the note picked, once the palette has closed and forgotten the query', async () => {
    const { store, onPick } = slot();
    act(() => showOverlay(store, 'search'));
    await userEvent.type(await screen.findByLabelText('Search the vault'), 'sour');
    await userEvent.click(await screen.findByRole('option', { name: /Recipes/ }));

    expect(onPick).toHaveBeenCalledWith('recipes.md');
    expect(overlayNow(store)).toBeNull();
    expect(store.getState().palette.query).toBe('');
    expect(palette()).toBeNull();
  });

  it('runs the command chosen with the query it was chosen from', async () => {
    const { store, onCommand } = slot();
    act(() => showOverlay(store, 'search'));
    await userEvent.type(await screen.findByLabelText('Search the vault'), 'new');
    await userEvent.click(await screen.findByRole('option', { name: /New view/ }));

    expect(onCommand).toHaveBeenCalledWith('new-view', 'new');
    expect(overlayNow(store)).toBeNull();
  });

  it('closes on Escape, choosing nothing', async () => {
    const { store, onCommand, onPick } = slot();
    act(() => showOverlay(store, 'search'));
    await userEvent.type(await screen.findByLabelText('Search the vault'), 'sour');
    await userEvent.keyboard('{Escape}');

    expect(overlayNow(store)).toBeNull();
    expect(store.getState().palette.query).toBe('');
    expect(onCommand).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('the search palette slot and the index (#326)', () => {
  it('searches again when the index has news while it is up, reading the news itself', async () => {
    const { store, status, reads, search } = slot();
    act(() => showOverlay(store, 'search'));
    await userEvent.type(await screen.findByLabelText('Search the vault'), 'sour');
    await waitFor(() => expect(search).toHaveBeenCalled());
    const asked = search.mock.calls.length;

    act(() => {
      status.setState({ revision: 2 });
      reads.indexMoved('/vault', false);
    });
    await waitFor(() => expect(search.mock.calls.length).toBe(asked + 1));
  });
});
