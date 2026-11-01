// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from './app-shell.tsx';

/**
 * The sidebar as a drawer on a narrow screen (#658): a modal dialog over the
 * work that the keyboard and a screen reader can open, stay in, and leave.
 */
function shell({
  open,
  onOpenChange = vi.fn(),
  onShowSidebar,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onShowSidebar?: () => void;
}) {
  const view = render(
    <AppShell
      sidebar={
        <>
          <button type="button">Hide sidebar</button>
          <button type="button">Today</button>
        </>
      }
      panes={<button type="button">In the note</button>}
      drawer={{ open, onOpenChange }}
      {...(onShowSidebar !== undefined && { onShowSidebar })}
    />,
  );
  return { ...view, onOpenChange };
}

describe('AppShell sidebar drawer', () => {
  it('keeps the sidebar out of the page while the drawer is closed, and offers a way in', async () => {
    const onShowSidebar = vi.fn();
    const { container } = shell({ open: false, onShowSidebar });
    expect(screen.queryByRole('navigation', { name: 'Vault' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.firstElementChild?.className).toContain('shell--compact');
    // Out of the flow: the stylesheet folds the aside as for a hidden sidebar.
    expect(container.firstElementChild?.className).toContain('shell--narrow');

    await userEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(onShowSidebar).toHaveBeenCalledTimes(1);
  });

  it('is a dialog named Sidebar holding the Vault navigation, which takes the focus when it opens', async () => {
    shell({ open: true });
    const drawer = screen.getByRole('dialog', { name: 'Sidebar' });
    expect(drawer.className).toContain('shell__drawer');
    expect(screen.getByRole('navigation', { name: 'Vault' })).toBeDefined();
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
  });

  it('takes the work behind it out of reach while open: inert, and hidden from a reader', async () => {
    // Tabbing round the trap itself is held in WebKit (e2e/narrow-screens.spec.ts):
    // jsdom does not keep the focus out of an inert subtree.
    shell({ open: true });
    const drawer = screen.getByRole('dialog', { name: 'Sidebar' });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    expect(screen.queryByRole('button', { name: 'In the note' })).toBeNull();
    const behind = screen.getByRole('button', { name: 'In the note', hidden: true });
    expect(behind.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(behind.closest('[data-base-ui-inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Today' })).toBeDefined();
  });

  it('asks to close on Escape', async () => {
    const { onOpenChange } = shell({ open: true });
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Sidebar' }).contains(document.activeElement)).toBe(
        true,
      ),
    );
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it('hands the focus to the way back in as it closes, when nothing held it as it opened', async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const onOpenChange = vi.fn();
    const back = document.createElement('button');
    document.body.append(back);
    const view = render(
      <AppShell
        sidebar={<button type="button">Today</button>}
        drawer={{ open: true, onOpenChange, returnFocus: () => back }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Sidebar' }).contains(document.activeElement)).toBe(
        true,
      ),
    );
    view.rerender(
      <AppShell
        sidebar={<button type="button">Today</button>}
        drawer={{ open: false, onOpenChange, returnFocus: () => back }}
      />,
    );
    await waitFor(() => expect(document.activeElement).toBe(back));
    back.remove();
  });

  it('is drawn exactly as before with no drawer: the wide window is untouched', () => {
    const { container } = render(<AppShell sidebar={<p>tree</p>} />);
    expect(container.firstElementChild?.className).toBe('shell');
    expect(screen.getByRole('navigation', { name: 'Vault' }).className).toBe('shell__sidebar');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
