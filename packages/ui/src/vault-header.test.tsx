// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VaultHeader } from './vault-header.tsx';

const templates = [
  { path: '.atlas/templates/Company.md', name: 'Company' },
  { path: '.atlas/templates/Person.md', name: 'Person' },
];

const props = {
  vaultName: 'Vault',
  vaultInitial: 'V',
  templates: [],
  onChooseVault: () => {},
  onNewNote: () => {},
  onNewFromTemplate: () => {},
  onDailyNote: () => {},
};

/**
 * The menu opens on the frame after the press, so every test that needs it open
 * waits for an item rather than reading the DOM straight after the click.
 */
async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: 'New note' }));
  return await screen.findByRole('menu', { name: 'New note from' });
}

describe('VaultHeader', () => {
  it('shows which vault is open', () => {
    render(<VaultHeader {...props} />);
    expect(screen.getByRole('button', { name: 'Vault' })).toBeDefined();
  });

  it('names the vault without a way to another where none can be opened (#657)', () => {
    render(
      <VaultHeader
        vaultName="Vault"
        vaultInitial="V"
        templates={[]}
        onOpenFromGitHub={() => {}}
        onNewNote={() => {}}
        onNewFromTemplate={() => {}}
        onDailyNote={() => {}}
      />,
    );
    expect(screen.getByText('Vault')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Vault' })).toBeNull();
  });

  it('shows the vault’s tile beside its name, without adding to the name', () => {
    render(<VaultHeader {...props} vaultInitial="Q" />);
    expect(screen.getByText('Q')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Vault' })).toBeDefined();
  });

  it('hides the sidebar from its own header', async () => {
    const onHideSidebar = vi.fn();
    render(<VaultHeader {...props} onHideSidebar={onHideSidebar} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(onHideSidebar).toHaveBeenCalledTimes(1);
  });

  it('offers no hide button when the app gives no way to hide it', () => {
    render(<VaultHeader {...props} />);
    expect(screen.queryByRole('button', { name: 'Hide sidebar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New note' })).toBeDefined();
  });

  it('offers to choose another folder', async () => {
    const onChooseVault = vi.fn();
    render(<VaultHeader {...props} onChooseVault={onChooseVault} />);
    await userEvent.click(screen.getByRole('button', { name: 'Vault' }));
    expect(onChooseVault).toHaveBeenCalledOnce();
  });

  it('offers another folder or a vault from GitHub when both are possible', async () => {
    const onChooseVault = vi.fn();
    const onOpenFromGitHub = vi.fn();
    render(
      <VaultHeader {...props} onChooseVault={onChooseVault} onOpenFromGitHub={onOpenFromGitHub} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Vault' }));
    expect(onChooseVault).not.toHaveBeenCalled();
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Open a vault from GitHub…' }),
    );
    expect(onOpenFromGitHub).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Vault' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Open another folder…' }));
    expect(onChooseVault).toHaveBeenCalledOnce();
  });

  it("offers a blank note and today's note even with no templates", async () => {
    render(<VaultHeader {...props} />);
    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Blank note' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: "Today's note" })).toBeDefined();
  });

  it("opens today's note from the menu", async () => {
    const onDailyNote = vi.fn();
    render(<VaultHeader {...props} onDailyNote={onDailyNote} />);
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: "Today's note" }));

    expect(onDailyNote).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('opens a menu when there are templates', async () => {
    render(<VaultHeader {...props} templates={templates} />);
    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Blank note' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Company' })).toBeDefined();
  });

  it('makes a blank note from the menu', async () => {
    const onNewNote = vi.fn();
    render(<VaultHeader {...props} templates={templates} onNewNote={onNewNote} />);
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Blank note' }));

    expect(onNewNote).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('makes a note from a chosen template', async () => {
    const onNewFromTemplate = vi.fn();
    render(<VaultHeader {...props} templates={templates} onNewFromTemplate={onNewFromTemplate} />);
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Person' }));

    expect(onNewFromTemplate).toHaveBeenCalledWith('.atlas/templates/Person.md');
  });

  it('closes the menu when something else is clicked', async () => {
    render(<VaultHeader {...props} templates={templates} />);
    await openMenu();

    await userEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('says whether the menu is open', async () => {
    render(<VaultHeader {...props} templates={templates} />);
    const button = screen.getByRole('button', { name: 'New note' });
    expect(button.getAttribute('aria-expanded')).toBe('false');

    await openMenu();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on Escape', async () => {
    render(<VaultHeader {...props} templates={templates} />);
    await openMenu();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('gives focus back to the button that opened it', async () => {
    render(<VaultHeader {...props} templates={templates} />);
    const button = screen.getByRole('button', { name: 'New note' });
    await openMenu();
    await waitFor(() => expect(document.activeElement).not.toBe(button));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('keeps arrow keys inside the menu', async () => {
    render(<VaultHeader {...props} templates={templates} />);
    const menu = await openMenu();

    // Four items: blank, today's, and one per template.
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(4);

    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    for (const item of items.slice(1)) {
      await userEvent.keyboard('{ArrowDown}');
      await waitFor(() => expect(document.activeElement).toBe(item));
    }

    // Past the last item, focus wraps rather than escaping to the page.
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it('locks the page behind it, and lets go when it closes', async () => {
    // The document is shared with the tests above, which release the lock a
    // frame after they are torn down — so wait for the clean slate rather than
    // assuming it.
    await waitFor(() => expect(document.body.style.overflowY).toBe(''));
    render(<VaultHeader {...props} templates={templates} />);

    await openMenu();
    await waitFor(() => expect(document.body.style.overflowY).toBe('hidden'));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.body.style.overflowY).toBe(''));
  });
});
