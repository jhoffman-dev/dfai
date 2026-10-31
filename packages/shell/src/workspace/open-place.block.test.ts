import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { createRevealStore } from '../panes/reveals.ts';
import { openNote, openNoteAtBlock } from './open-place.ts';
import { createWorkspaceStore, loadVault, workspaceNow } from './workspace-store.ts';

const ART = createVaultPath('Library/The Art of War.md');
const PLAN = createVaultPath('Plan.md');

function opening() {
  const store = createWorkspaceStore({ remembered: { read: () => null, write: () => {} } });
  loadVault(store, '/v');
  return { store, reveals: createRevealStore() };
}

const placesOf = (store: ReturnType<typeof opening>['store'], pane = 0) =>
  workspaceNow(store).panes[pane]?.tabs.map((tab) => tab.history.current) ?? [];

describe('openNoteAtBlock (#507)', () => {
  it('opens the note where asked and asks the tab it opened in to bring the block into view', () => {
    const wiring = opening();
    openNote(wiring.store, PLAN);
    openNoteAtBlock(wiring, { path: ART, block: 'k3x9q2', how: 'new-tab' });

    expect(placesOf(wiring.store)).toEqual([
      { kind: 'note', path: PLAN },
      { kind: 'note', path: ART },
    ]);
    const tab = workspaceNow(wiring.store).panes[0]?.active ?? '';
    expect(wiring.reveals.getState().byTab.get(tab)).toMatchObject({
      path: ART,
      reveal: { fragment: { kind: 'block', id: 'k3x9q2' } },
    });
  });

  it('opens here by default, in the tab already shown', () => {
    const wiring = opening();
    openNote(wiring.store, PLAN);
    const before = workspaceNow(wiring.store).panes[0]?.active;
    openNoteAtBlock(wiring, { path: ART, block: 'ab12cd' });
    expect(placesOf(wiring.store)).toEqual([{ kind: 'note', path: ART }]);
    expect(wiring.reveals.getState().byTab.get(before ?? '')?.reveal.fragment).toEqual({
      kind: 'block',
      id: 'ab12cd',
    });
  });
});
