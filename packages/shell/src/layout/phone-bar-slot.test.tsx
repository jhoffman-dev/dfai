// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { createVaultPath, PHONE_SCREENS } from '@dfai/domain';
import { PhoneBarSlot } from './phone-bar-slot.tsx';
import { createWorkspaceStore, openPlace } from '../workspace/workspace-store.ts';

/**
 * The phone's bar reads the focused pane (#672): Today is marked while the
 * pane shows the Today page, and nothing is while it shows a note or another page.
 */
function slot() {
  const store = createWorkspaceStore({ remembered: { read: () => null, write: () => {} } });
  const onOpen = vi.fn();
  render(<PhoneBarSlot screens={PHONE_SCREENS} workspace={store} onOpen={onOpen} />);
  const current = (name: string) =>
    screen.getByRole('button', { name }).getAttribute('aria-current');
  return { store, onOpen, current };
}

describe('PhoneBarSlot', () => {
  it('marks Today while the focused pane shows the Today page, and drops the mark on a note', () => {
    const { store, current } = slot();
    expect(current('Today')).toBeNull();

    act(() => openPlace(store, { kind: 'today' }, 'here'));
    expect(current('Today')).toBe('page');
    expect(current('Quick add')).toBeNull();
    expect(current('Notes')).toBeNull();

    act(() => openPlace(store, { kind: 'note', path: createVaultPath('Garden plan.md') }, 'here'));
    expect(current('Today')).toBeNull();
  });

  it('marks nothing for another page: the Inbox is not one of the bar’s screens', () => {
    const { store, current } = slot();
    act(() => openPlace(store, { kind: 'inbox' }, 'here'));
    expect(current('Today')).toBeNull();
    expect(current('Notes')).toBeNull();
  });

  it('hands each screen on as pressed', () => {
    const { onOpen } = slot();
    screen.getByRole('button', { name: 'Notes' }).click();
    expect(onOpen).toHaveBeenCalledWith('notes');
  });
});
