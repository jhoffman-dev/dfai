// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PHONE_SCREENS } from '@dfai/domain';
import { PhoneBar } from './phone-bar.tsx';

/**
 * The bar along a phone's bottom edge (#672): it draws the screens the rule
 * names, in the rule's order, and says which one is showing.
 */
describe('PhoneBar', () => {
  it('draws the screens the rule names, in its order, as a navigation of buttons', () => {
    render(<PhoneBar screens={PHONE_SCREENS} current={null} onOpen={vi.fn()} />);
    const bar = screen.getByRole('navigation', { name: 'Screens' });
    const names = within(bar)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names).toEqual(['Quick add', 'Today', 'Notes']);
  });

  it('draws only the screens it is handed', () => {
    render(<PhoneBar screens={['today', 'notes']} current={null} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Quick add' })).toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Today',
      'Notes',
    ]);
  });

  it('opens the screen a button names, and that one only', async () => {
    const onOpen = vi.fn();
    render(<PhoneBar screens={PHONE_SCREENS} current={null} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Quick add' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith('quick-add');
    await userEvent.click(screen.getByRole('button', { name: 'Notes' }));
    expect(onOpen).toHaveBeenLastCalledWith('notes');
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onOpen).toHaveBeenLastCalledWith('today');
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('marks the screen showing as where you are, and no other', () => {
    render(<PhoneBar screens={PHONE_SCREENS} current="today" onOpen={vi.fn()} />);
    const current = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-current');
    expect(current('Today')).toBe('page');
    expect(current('Quick add')).toBeNull();
    expect(current('Notes')).toBeNull();
  });

  it('marks nothing while the pane shows none of its screens', () => {
    render(<PhoneBar screens={PHONE_SCREENS} current={null} onOpen={vi.fn()} />);
    const marked = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(marked).toEqual([]);
  });
});
