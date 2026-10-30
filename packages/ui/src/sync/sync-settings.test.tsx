// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncSettings, type SyncSettingsView } from './sync-settings.tsx';
import { SyncIndicator } from './sync-indicator.tsx';
import { OpenFromGitHubDialog } from './open-from-github-dialog.tsx';

const view = (overrides: Partial<SyncSettingsView> = {}): SyncSettingsView => ({
  stage: 'set-up',
  statusLine: 'Synced at 2:05 PM',
  tone: 'ok',
  problem: null,
  remote: 'git@github.com:james/notes.git',
  suggestedName: 'Notes',
  busy: false,
  pushDelaySeconds: 30,
  pushDelayChoices: [10, 30, 60, 120],
  pullIntervalMinutes: 1,
  pullIntervalChoices: [1, 5, 10],
  paused: false,
  thisMac: 'Studio',
  automationsMac: 'Studio',
  automationsHere: true,
  claiming: false,
  conflicts: [],
  notSynced: [],
  ignored: [],
  repositories: { kind: 'ready', repositories: [] },
  ...overrides,
});

function show(overrides: Partial<SyncSettingsView> = {}) {
  const actions = {
    onCreate: vi.fn(),
    onConnect: vi.fn(),
    onSyncNow: vi.fn(),
    onPushDelay: vi.fn(),
    onPullInterval: vi.fn(),
    onPause: vi.fn(),
    onClaimAutomations: vi.fn(),
    onLoadRepositories: vi.fn(),
    findRepositories: vi.fn(() => []),
  };
  render(<SyncSettings view={view(overrides)} {...actions} />);
  return actions;
}

describe('SyncSettings', () => {
  it('sets up a new private repository under the suggested name, or one typed over it', async () => {
    const { onCreate } = show({ stage: 'not-set-up', statusLine: 'Not set up', remote: null });
    const form = screen.getByRole('form', { name: 'Set up sync with GitHub' });
    const name = within(form).getByRole('textbox');
    expect((name as HTMLInputElement).value).toBe('Notes');
    await userEvent.clear(name);
    await userEvent.type(name, 'my-notes');
    await userEvent.click(screen.getByRole('button', { name: 'Set up sync with GitHub' }));
    expect(onCreate).toHaveBeenCalledWith('my-notes');
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('connects an existing repository by its address, once one is typed', async () => {
    const { onConnect } = show({ stage: 'not-set-up', remote: null });
    const connect = screen.getByRole('button', { name: 'Connect existing repo' });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    const form = screen.getByRole('form', { name: 'Connect an existing repository' });
    await userEvent.type(within(form).getByRole('textbox'), 'git@github.com:j/n.git');
    await userEvent.click(connect);
    expect(onConnect).toHaveBeenCalledWith('git@github.com:j/n.git');
  });

  it('shows how a synced vault stands, and syncs when asked', async () => {
    const { onSyncNow, onPushDelay, onPullInterval } = show();
    expect(screen.getByTestId('sync-status').textContent).toBe('Synced at 2:05 PM');
    expect(screen.getByText('git@github.com:james/notes.git')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(onSyncNow).toHaveBeenCalledOnce();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'How often to look for other Macs’ changes' }),
      '10',
    );
    expect(onPullInterval).toHaveBeenCalledWith(10);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'When to send changes' }),
      '120',
    );
    expect(onPushDelay).toHaveBeenCalledWith(120);
    expect(screen.queryByRole('form', { name: 'Set up sync with GitHub' })).toBeNull();
  });

  it('holds Sync now while a sync runs', () => {
    show({ busy: true, statusLine: 'Syncing…' });
    expect((screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('lets this Mac take the automations from another, and not give them away to none', async () => {
    const { onClaimAutomations } = show({ automationsHere: false, automationsMac: 'Laptop' });
    expect(screen.getByTestId('automations-mac').textContent).toContain('Laptop runs them');
    const toggle = screen.getByRole('switch', { name: 'Run automations on this Mac' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle);
    expect(onClaimAutomations).toHaveBeenCalledOnce();
  });

  it('holds the automations switch while a claim waits its turn, and says why one named no Mac (#630 review)', () => {
    show({
      automationsHere: false,
      automationsMac: 'Laptop',
      claiming: true,
      problem: 'This Mac could not be named in the vault’s settings: the disk is full',
    });
    const toggle = screen.getByRole('switch', { name: 'Run automations on this Mac' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/could not be named.*the disk is full/)).toBeTruthy();
  });

  it('keeps the automations switch on and still on the Mac that has them', () => {
    show();
    const toggle = screen.getByRole('switch', { name: 'Run automations on this Mac' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns about files both Macs changed, naming where the other version went', () => {
    show({
      tone: 'warning',
      conflicts: [{ path: 'Ideas.md', copy: 'Ideas (conflict from Laptop).md', whose: 'theirs' }],
    });
    const warning = screen.getByRole('status');
    expect(warning.textContent).toContain('Both Macs changed a file');
    expect(within(warning).getByText('Ideas (conflict from Laptop).md')).toBeDefined();
  });

  it('pauses and resumes sync on this Mac, saying what pausing means', async () => {
    const { onPause } = show();
    const pause = screen.getByRole('switch', { name: 'Pause sync on this Mac' });
    expect(pause.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(pause);
    expect(onPause).toHaveBeenCalledWith(true);
    cleanup();
    const paused = show({ paused: true, statusLine: 'Paused on this Mac' });
    expect(screen.getByText(/Nothing is sent or brought in/)).toBeDefined();
    await userEvent.click(screen.getByRole('switch', { name: 'Pause sync on this Mac' }));
    expect(paused.onPause).toHaveBeenCalledWith(false);
  });

  it('says automations wait while sync is paused on the Mac that runs them (ADR-0035 part 4)', () => {
    show({ paused: true, automationsHere: true });
    expect(screen.getByText(/Automations on this Mac wait too/)).toBeDefined();
    cleanup();
    show({ paused: true, automationsHere: false });
    expect(screen.getByText(/Nothing is sent or brought in/)).toBeDefined();
    expect(screen.queryByText(/Automations on this Mac wait too/)).toBeNull();
  });

  it('lists what stays on this Mac unsynced, and why', () => {
    show({ notSynced: ['Projects/site/', 'Attachments/talk.mov'] });
    const list = screen.getByText('Staying on this Mac, not synced').closest('div');
    expect(list?.textContent).toContain('Projects/site/ is a git repository of its own');
    expect(list?.textContent).toContain('Attachments/talk.mov is over GitHub’s 100 MB limit');
  });

  // Issue #8: a line of the person's .gitignore kept `.atlas` off GitHub without a word.
  it('lists what the vault’s own .gitignore keeps out of sync, and why', () => {
    show({ ignored: ['.atlas/types/', '.atlas/settings.md'] });
    const list = screen.getByText('Staying on this Mac, not synced').closest('div');
    expect(list?.textContent).toContain('.atlas/types/ is left out by this vault’s .gitignore');
    expect(list?.textContent).toContain(
      '.atlas/settings.md is left out by this vault’s .gitignore',
    );
    expect(list?.textContent).not.toContain('repository of its own');
  });

  it('names a file both Macs made in different case as both kept', () => {
    show({
      conflicts: [{ path: 'Idea.md', copy: 'idea (conflict from Laptop).md', whose: 'ours' }],
    });
    const warning = screen.getByRole('status');
    expect(warning.textContent).toContain('differ only in case');
    expect(warning.textContent).toContain('(this Mac’s)');
  });

  it('says why a vault cannot sync, and offers no way to set it up', () => {
    show({ stage: 'refused', problem: 'This vault is inside another git repository (atlas)' });
    expect(screen.getByRole('alert').textContent).toContain('inside another git repository');
    expect(screen.queryByRole('form', { name: 'Set up sync with GitHub' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });
});

describe('SyncIndicator', () => {
  it('names how sync stands and opens Settings', async () => {
    const onOpen = vi.fn();
    render(<SyncIndicator badge={{ tone: 'warning', label: '1 conflict' }} onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: 'Sync: 1 conflict' });
    expect(button.getAttribute('data-tone')).toBe('warning');
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('OpenFromGitHubDialog', () => {
  it('hands on the address, and says why the last try failed', async () => {
    const onOpen = vi.fn();
    render(
      <OpenFromGitHubDialog
        busy={false}
        problem="GitHub can’t find that repository"
        onOpen={onOpen}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('can’t find');
    const choose = screen.getByRole('button', { name: 'Choose folder…' });
    expect((choose as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Repository address' }),
      'git@github.com:j/n.git',
    );
    await userEvent.click(choose);
    expect(onOpen).toHaveBeenCalledWith('git@github.com:j/n.git');
  });

  it('closes on Cancel', async () => {
    const onClose = vi.fn();
    render(
      <OpenFromGitHubDialog busy={false} problem={null} onOpen={() => {}} onClose={onClose} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
