// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';

import { AppShell } from './app-shell.tsx';
import { DeleteDialog } from './delete-dialog.tsx';
import { holdModalLayer } from './modal-layer.ts';
import { SettingsUnavailable } from './settings-dialog.tsx';
import { Toast } from './toast.tsx';

/**
 * The app behind an open modal is out of reach of the keyboard as well as of
 * assistive tech (#827): Base UI hides it with `aria-hidden` but leaves it
 * tabbable, so until the dialog's first focus lands a frame later, Tab walked
 * the sidebar and the tab strip behind it.
 */
function WithSettings({ notices = null }: { notices?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <AppShell
      notices={notices}
      status="208 notes indexed"
      sidebar={
        <button type="button" onClick={() => setOpen(true)}>
          Settings
        </button>
      }
      overlay={
        open && (
          <SettingsUnavailable onClose={() => setOpen(false)}>Nothing here</SettingsUnavailable>
        )
      }
    />
  );
}

const NOTE = { name: 'Today', kind: 'note', notes: 1, otherFiles: 0, unsaved: [] } as const;

function WithDelete() {
  const [open, setOpen] = useState(false);
  return (
    <AppShell
      sidebar={
        <button type="button" onClick={() => setOpen(true)}>
          Delete
        </button>
      }
      overlay={
        open && (
          <DeleteDialog
            subject={NOTE}
            onConfirm={() => setOpen(false)}
            onClose={() => setOpen(false)}
          />
        )
      }
    />
  );
}

/** Whether the keyboard and assistive tech are kept out of `element`. */
const inert = (element: Element): boolean => element.closest('[inert]') !== null;

/** A dialog drawn inside the app, as the peek's gallery specimen is, over its pane. */
function WithDialogInside() {
  const pane = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <AppShell
      sidebar={
        <button type="button" onClick={() => setOpen(true)}>
          Peek
        </button>
      }
      main={
        <div ref={pane}>
          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Portal ref={holdModalLayer} container={pane}>
              <Dialog.Popup aria-label="Peek">
                <Dialog.Close>Close</Dialog.Close>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      }
    />
  );
}

describe('AppShell behind a modal', () => {
  it('makes the app inert while a dialog is open, and gives the focus back to the opener on close', async () => {
    const user = userEvent.setup();
    render(<WithSettings />);
    const opener = screen.getByRole('button', { name: 'Settings' });
    expect(inert(opener)).toBe(false);

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(() => expect(inert(opener)).toBe(true));
    expect(inert(dialog)).toBe(false);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(inert(opener)).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('makes the app inert while an alert dialog is open', async () => {
    const user = userEvent.setup();
    render(<WithDelete />);
    const opener = screen.getByRole('button', { name: 'Delete' });

    await user.click(opener);
    await screen.findByRole('alertdialog');
    await waitFor(() => expect(inert(opener)).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(inert(opener)).toBe(false);
  });

  it('lets go of the app when it unmounts with a dialog still open', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<WithSettings />);
    const opener = screen.getByRole('button', { name: 'Settings' });
    await user.click(opener);
    await waitFor(() => expect(inert(opener)).toBe(true));

    unmount();
    expect(inert(opener)).toBe(false);
  });

  it('keeps a toast raised behind an open dialog announced and dismissable', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <WithSettings
        notices={<Toast message="Sync is offline" tone="error" onDismiss={onDismiss} />}
      />,
    );
    const opener = screen.getByRole('button', { name: 'Settings' });
    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(() => expect(inert(opener)).toBe(true));

    expect(inert(screen.getByText('Sync is offline'))).toBe(false);
    expect(inert(screen.getByText('208 notes indexed'))).toBe(false);
    // Base UI's own `aria-hidden` still covers it (it spares only `[aria-live]`), as before #827.
    await user.click(screen.getByRole('button', { name: 'Dismiss', hidden: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('counts a ref run twice by StrictMode once', async () => {
    const user = userEvent.setup();
    render(<WithSettings />, { reactStrictMode: true });
    const opener = screen.getByRole('button', { name: 'Settings' });
    await user.click(opener);
    await waitFor(() => expect(inert(opener)).toBe(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(inert(opener)).toBe(false);
  });

  it('leaves the app alone for a dialog drawn inside it', async () => {
    const user = userEvent.setup();
    render(<WithDialogInside />);
    const opener = screen.getByRole('button', { name: 'Peek' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Peek' });

    expect(inert(dialog)).toBe(false);
    expect(inert(opener)).toBe(false);
  });
});

describe('the modal layer', () => {
  it('keeps the app inert until the last of two open modals closes', () => {
    render(<WithSettings />);
    const opener = screen.getByRole('button', { name: 'Settings' });
    const outer = document.body.appendChild(document.createElement('div'));
    const inner = document.body.appendChild(document.createElement('div'));

    const releaseOuter = holdModalLayer(outer);
    const releaseInner = holdModalLayer(inner);
    expect(inert(opener)).toBe(true);
    releaseInner?.();
    expect(inert(opener)).toBe(true);
    releaseOuter?.();
    expect(inert(opener)).toBe(false);
  });

  it('makes what the app mounts while a modal is open inert too, and frees it on close', async () => {
    const shell = (sidebarOpen: boolean, settings: boolean) => (
      <AppShell
        sidebar={<p>tree</p>}
        sidebarOpen={sidebarOpen}
        onShowSidebar={() => undefined}
        overlay={
          settings && (
            <SettingsUnavailable onClose={() => undefined}>Nothing here</SettingsUnavailable>
          )
        }
      />
    );
    const { rerender } = render(shell(true, true));
    await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(() => expect(inert(screen.getByText('tree'))).toBe(true));

    // The window narrowed: the sidebar goes, and the way back to it comes in.
    rerender(shell(false, true));
    const showSidebar = screen.getByRole('button', { name: 'Show sidebar', hidden: true });
    await waitFor(() => expect(inert(showSidebar)).toBe(true));

    rerender(shell(false, false));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(inert(showSidebar)).toBe(false);
  });
});
