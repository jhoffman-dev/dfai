// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog, type ConnectionSettingsState } from './settings-dialog.tsx';
import { SETTINGS_SECTIONS, type SettingsSectionLink } from './settings-section-links.ts';
import { systemPreferring, themeStoreHolding } from './theme-test-support.ts';
import type { Theme } from './theme.ts';

const RUNNING = { enabled: true, port: 7420, running: true, file: '/Users/j/api.json' };
const OFF = { enabled: false, port: null, running: false, file: '/Users/j/api.json' };

function show(connection: Partial<ConnectionSettingsState> = {}, placeholder = false) {
  return showWith({ connection, placeholder });
}

function showWith({
  connection = {},
  placeholder = false,
  chosen = null,
  sections = [],
  connections,
}: {
  connection?: Partial<ConnectionSettingsState>;
  placeholder?: boolean;
  /** The theme the store holds; null for none chosen. */
  chosen?: Theme | null;
  sections?: readonly SettingsSectionLink[];
  connections?: boolean;
}) {
  const store = themeStoreHolding(chosen);
  const handlers = {
    onEnable: vi.fn(),
    onCopyToken: vi.fn(),
    onRotateToken: vi.fn(),
    onCopyMcpCommand: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <SettingsDialog
      connection={{ status: OFF, problem: null, notice: null, pending: false, ...connection }}
      mcp={{ command: 'claude mcp add atlas -- node /x/main.js', placeholder }}
      themeStore={store}
      sections={sections}
      {...(connections !== undefined && { connections })}
      {...handlers}
    >
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={section.id}>
          <h2 id={section.id} tabIndex={-1}>
            {section.title}
          </h2>
        </section>
      ))}
    </SettingsDialog>,
  );
  return { ...handlers, store };
}

const statusText = () => screen.getByTestId('api-status').textContent;
const apiSwitch = () => screen.getByRole('switch', { name: 'Local API' });

describe('SettingsDialog, where there is no local API (#657)', () => {
  it('draws Connections, and lists it, by default', () => {
    showWith({});
    expect(apiSwitch()).toBeDefined();
    const list = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(list).getByRole('button', { name: 'Connections' })).toBeDefined();
  });

  it('neither draws nor lists Connections when it is not offered', () => {
    showWith({ connections: false });
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeDefined();
    expect(screen.queryByRole('switch', { name: 'Local API' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Connections' })).toBeNull();
    const list = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((row) => row.textContent),
    ).toEqual(['Appearance']);
  });
});

describe('SettingsDialog, Connections', () => {
  it('reads Off, with the switch off, while the API is off', () => {
    show({ status: OFF });
    expect(statusText()).toBe('Off');
    expect(apiSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('names the port while the API is running', () => {
    show({ status: RUNNING });
    expect(statusText()).toBe('Running on port 7420');
    expect(apiSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('says so when the API is on but not listening', () => {
    show({ status: { ...RUNNING, running: false } });
    expect(statusText()).toBe('On, but not running');
  });

  it('waits for the host before offering the switch', () => {
    show({ status: null });
    expect(statusText()).toBe('Checking…');
    expect(apiSwitch()).toHaveProperty('disabled', true);
  });

  it('shows why the last action failed', () => {
    show({ problem: 'cannot listen on 127.0.0.1: address in use' });
    expect(screen.getByRole('alert').textContent).toBe(
      'cannot listen on 127.0.0.1: address in use',
    );
  });

  it('turns the API on from the switch', async () => {
    const { onEnable } = show({ status: OFF });
    await userEvent.click(apiSwitch());
    expect(onEnable).toHaveBeenCalledWith(true);
  });

  it('holds every control while an action is under way', () => {
    show({ pending: true });
    expect(apiSwitch()).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Copy token' })).toHaveProperty('disabled', true);
  });

  it('copies the token', async () => {
    const { onCopyToken } = show();
    await userEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(onCopyToken).toHaveBeenCalledOnce();
  });

  it('asks before rotating the token, and rotates only once confirmed', async () => {
    const { onRotateToken } = show();

    await userEvent.click(screen.getByRole('button', { name: 'Rotate token…' }));
    expect(onRotateToken).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(onRotateToken).toHaveBeenCalledOnce();
  });

  it('rotates nothing when the confirmation is cancelled', async () => {
    const { onRotateToken } = show();

    await userEvent.click(screen.getByRole('button', { name: 'Rotate token…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onRotateToken).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rotate token…' })).toBeDefined();
  });

  it('shows the MCP command and copies it', async () => {
    const { onCopyMcpCommand } = show();
    expect(screen.getByText('claude mcp add atlas -- node /x/main.js')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Copy MCP command' }));
    expect(onCopyMcpCommand).toHaveBeenCalledOnce();
  });

  it('says the path needs filling in when it is only a placeholder', () => {
    show({}, true);
    expect(screen.getByText(/Replace the path/)).toBeDefined();
  });

  it('does not ask for a path it already has', () => {
    show({}, false);
    expect(screen.queryByText(/Replace the path/)).toBeNull();
  });

  it('shows where the connection file is', () => {
    show({ status: RUNNING });
    expect(screen.getByText('/Users/j/api.json').tagName).toBe('CODE');
  });

  it('says what the last action did', () => {
    show({ notice: 'Token copied' });
    expect(screen.getByText('Token copied')).toBeDefined();
  });

  it('closes from its Close button', async () => {
    const { onClose } = show();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

const matchSystem = () => screen.getByRole('switch', { name: 'Match system' });

describe('SettingsDialog, Appearance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset['theme'];
  });

  it('has Match system on while nothing is chosen, and says what the system is', () => {
    vi.stubGlobal('matchMedia', systemPreferring(true).matchMedia);
    showWith({ chosen: null });
    expect(matchSystem().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('theme-status').textContent).toContain('Dark now');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('has Match system off while a theme is chosen, and says which', () => {
    showWith({ chosen: 'dark' });
    expect(matchSystem().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('theme-status').textContent).toMatch(/^Dark, chosen/);
  });

  it('turning Match system on clears the choice, and the system theme applies', async () => {
    vi.stubGlobal('matchMedia', systemPreferring(false).matchMedia);
    const { store } = showWith({ chosen: 'dark' });
    expect(document.documentElement.dataset['theme']).toBe('dark');

    await userEvent.click(matchSystem());

    expect(store.read()).toBeNull();
    expect(store.written).toEqual([null]);
    expect(matchSystem().getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('turning Match system off keeps the theme showing, as the choice', async () => {
    vi.stubGlobal('matchMedia', systemPreferring(true).matchMedia);
    const { store } = showWith({ chosen: null });

    await userEvent.click(matchSystem());

    expect(store.read()).toBe('dark');
    expect(matchSystem().getAttribute('aria-checked')).toBe('false');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('follows the system while matching it', () => {
    const system = systemPreferring(false);
    vi.stubGlobal('matchMedia', system.matchMedia);
    showWith({ chosen: null });
    expect(document.documentElement.dataset['theme']).toBe('light');

    act(() => system.prefer(true));

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(screen.getByTestId('theme-status').textContent).toContain('Dark now');
  });
});

describe('SettingsDialog, the list of sections', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists its own sections, then the app’s, as rows', () => {
    showWith({ sections: [SETTINGS_SECTIONS.profile, SETTINGS_SECTIONS.sync] });
    const list = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((row) => row.textContent),
    ).toEqual(['Appearance', 'Connections', 'Profile', 'Sync']);
  });

  it('draws a section as a hairline group, not a card', () => {
    show();
    const connections = screen.getByRole('region', { name: 'Connections' });
    expect(connections.className).toBe('settings__section');
    expect(document.querySelector('.settings__card')).toBeNull();
  });

  it('a row brings its section into view and hands it the focus', async () => {
    // jsdom lays nothing out, so it has no scrollIntoView to call; given
    // one for this test, and taken away again by the afterEach's restore.
    Element.prototype.scrollIntoView = () => {};
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    showWith({ sections: [SETTINGS_SECTIONS.sync] });
    const list = screen.getByRole('navigation', { name: 'Settings sections' });

    await userEvent.click(within(list).getByRole('button', { name: 'Sync' }));

    const heading = screen.getByRole('heading', { name: 'Sync' });
    expect(document.activeElement).toBe(heading);
    expect(scrolled).toHaveBeenCalledOnce();
    expect(scrolled.mock.instances[0]).toBe(heading);
  });
});
