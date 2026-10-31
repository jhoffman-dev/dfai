import { describe, expect, it, vi } from 'vitest';
import { activePlace, ASK_PLACE, createVaultPath } from '@dfai/domain';
import {
  createWorkspaceStore,
  loadVault,
  openPlace,
  toggleAsk,
  workspaceNow,
} from './workspace-store.ts';

const PLAN = { kind: 'note', path: createVaultPath('Plan.md') } as const;

function store() {
  const write = vi.fn();
  const made = createWorkspaceStore({ remembered: { read: () => null, write } });
  loadVault(made, '/v');
  return { made, write };
}

describe('toggleAsk (⌘J, #37)', () => {
  it('opens Ask, then goes back to the note, each a change it remembers', () => {
    const { made, write } = store();
    openPlace(made, PLAN, 'here');
    write.mockClear();
    expect(toggleAsk(made)).toBe(true);
    expect(activePlace(workspaceNow(made))).toEqual(ASK_PLACE);
    expect(toggleAsk(made)).toBe(false);
    expect(activePlace(workspaceNow(made))).toEqual(PLAN);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('says Ask is shown when it stayed on an Ask with nowhere to go back to', () => {
    const { made } = store();
    expect(toggleAsk(made)).toBe(true);
    expect(toggleAsk(made)).toBe(true);
    expect(activePlace(workspaceNow(made))).toEqual(ASK_PLACE);
  });
});
