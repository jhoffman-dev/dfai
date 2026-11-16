// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { AppShell } from './app-shell.tsx';
import { DeleteDialog } from './delete-dialog.tsx';
import { SettingsUnavailable } from './settings-dialog.tsx';

/**
 * The app behind an open modal is out of reach of the keyboard as well as of
 * assistive tech (#827): Base UI hides it with `aria-hidden` but leaves it
 * tabbable, so until the dialog's first focus lands a frame later, Tab walked
 * the sidebar and the tab strip behind it.
 */
function WithSettings() {
  const [open, setOpen] = useState(false);
  return (
    <AppShell
      sidebar={
        <button type="button" onClick={() => setOpen(true)}>
          Settings
        </button>
      }
      overlay={
        open && <SettingsUnavailable onClose={() => setOpen(false)}>Nothing here</SettingsUnavailable>
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
          <DeleteDialog subject={NOTE} onConfirm={() => setOpen(false)} onClose={() => setOpen(false)} />
        )
      }
    />
  );
}

function shellOf(container: HTMLElement): HTMLElement {
  const shell = container.querySelector<HTMLElement>('.shell');
  if (shell === null) throw new Error('no shell');
  return shell;
}

describe('AppShell behind a modal', () => {
  it('makes the app inert while a dialog is open, and gives the focus back to the opener on close', async () => {
    const user = userEvent.setup();
    const app = shellOf(render(<WithSettings />).container);
    expect(app.hasAttribute('inert')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(() => expect(app.hasAttribute('inert')).toBe(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.hasAttribute('inert')).toBe(false);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' })),
    );
  });

  it('makes the app inert while an alert dialog is open', async () => {
    const user = userEvent.setup();
    const app = shellOf(render(<WithDelete />).container);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('alertdialog');
    await waitFor(() => expect(app.hasAttribute('inert')).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(app.hasAttribute('inert')).toBe(false);
  });

  it('lets go of the app when it unmounts with a dialog still open', async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<WithSettings />);
    const app = shellOf(container);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(app.hasAttribute('inert')).toBe(true));

    unmount();
    expect(app.hasAttribute('inert')).toBe(false);
  });
});
