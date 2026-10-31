/** Attack on PR #428: a link clicked inside the peek is read against the peeked note. */
import { describe, expect, it, vi } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { createRevealStore } from '../panes/reveals.ts';
import { createOverlayStore, openPeek, peekNow } from '../overlay-store.ts';
import { clickLink, openNote } from './open-place.ts';
import { createWorkspaceStore, loadVault, workspaceNow } from './workspace-store.ts';

const PLAN = createVaultPath('Plan.md');
const ERRAND = createVaultPath('Errand.md');

function peeking() {
  const store = createWorkspaceStore({ remembered: { read: () => null, write: () => {} } });
  loadVault(store, '/v');
  return {
    store,
    reveals: createRevealStore(),
    overlays: createOverlayStore(),
    notePaths: [PLAN, ERRAND],
    onProblem: vi.fn(),
  };
}

const shownIn = (store: ReturnType<typeof peeking>['store']) =>
  workspaceNow(store).panes[0]?.tabs.map((tab) => tab.history.current);

describe('clickLink inside the peek (attack-428)', () => {
  it('opens the peeked note at its own heading for a [[#heading]] link, not the pane’s note', () => {
    const wiring = peeking();
    openNote(wiring.store, PLAN);
    openPeek(wiring.overlays, { path: ERRAND, from: null });

    // `[[#Goals]]` written in Errand.md, clicked in the peek showing it.
    clickLink(wiring, { pane: 0, target: '', heading: '#Goals', how: 'here', inPeek: true });

    expect(peekNow(wiring.overlays)).toBeNull();
    expect(shownIn(wiring.store)).toEqual([{ kind: 'note', path: ERRAND }]);
  });
});
