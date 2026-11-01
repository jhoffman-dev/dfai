// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog, SettingsUnavailable } from './settings-dialog.tsx';
import { SETTINGS_SECTIONS, type SettingsSectionLink } from './settings-section-links.ts';
import { SettingsSection } from './settings-section.tsx';
import { themeStoreHolding } from './theme-test-support.ts';

/**
 * Attack on PR #371 (slice 13f): the list of sections on the left — keyboard
 * use, rows whose section is not drawn, and the ids the list relies on.
 */

const OFF = { enabled: false, port: null, running: false, file: '/Users/example/api.json' };

function open(sections: readonly SettingsSectionLink[], drawn = sections) {
  render(
    <SettingsDialog
      connection={{ status: OFF, problem: null, notice: null, pending: false }}
      mcp={{ command: 'claude mcp add atlas -- node /x/main.js', placeholder: false }}
      themeStore={themeStoreHolding(null)}
      sections={sections}
      connections
      onEnable={vi.fn()}
      onCopyToken={vi.fn()}
      onRotateToken={vi.fn()}
      onCopyMcpCommand={vi.fn()}
      onClose={vi.fn()}
    >
      {drawn.map((section) => (
        <SettingsSection key={section.id} section={section}>
          <button type="button">{`${section.title} first control`}</button>
        </SettingsSection>
      ))}
    </SettingsDialog>,
  );
}

/** Base UI moves focus into the dialog after mounting; wait for it before driving keys. */
const settled = () =>
  waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' })));

const list = () => screen.getByRole('navigation', { name: 'Settings sections' });
const row = (name: string) => within(list()).getByRole('button', { name });

let scrolled: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // jsdom lays nothing out and has no scrollIntoView.
  scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled as unknown as Element['scrollIntoView'];
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe('SettingsDialog section list, attack 371', () => {
  it('opens with the focus on Close', async () => {
    open([SETTINGS_SECTIONS.index]);
    await settled();
  });

  it('a row chosen with the keyboard focuses its heading, and the next Tab lands on the section’s first control', async () => {
    open([SETTINGS_SECTIONS.index, SETTINGS_SECTIONS.claude]);
    const user = userEvent.setup();
    await settled();
    row('Claude').focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /^Claude$/ }));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Claude first control' }),
    );
  });

  it('Space on a row reveals its section too', async () => {
    open([SETTINGS_SECTIONS.index]);
    const user = userEvent.setup();
    await settled();
    row('Connections').focus();
    await user.keyboard(' ');
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.id).toBe(SETTINGS_SECTIONS.connections.id);
  });

  it('the Appearance row hands Tab on to the Match system switch', async () => {
    open([]);
    const user = userEvent.setup();
    await user.click(row('Appearance'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Match system' }));
  });

  it('a row whose section is not drawn does nothing, and does not throw', async () => {
    open([SETTINGS_SECTIONS.sync], []);
    const user = userEvent.setup();
    await user.click(row('Sync'));
    expect(scrolled).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row('Sync'));
  });

  it('lists the dialog’s own sections first, and each heading id appears once in the document', () => {
    const app = [SETTINGS_SECTIONS.profile, SETTINGS_SECTIONS.index, SETTINGS_SECTIONS.sync];
    open(app);
    const rows = within(list())
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(rows).toEqual(['Appearance', 'Connections', 'Profile', 'Index', 'Sync']);
    for (const section of [SETTINGS_SECTIONS.appearance, SETTINGS_SECTIONS.connections, ...app]) {
      expect(document.querySelectorAll(`#${section.id}`)).toHaveLength(1);
    }
  });

  it('every nav row is a reachable button, in list order, by Tab', async () => {
    open([SETTINGS_SECTIONS.index]);
    const user = userEvent.setup();
    await settled();
    row('Appearance').focus();
    await user.tab();
    expect(document.activeElement).toBe(row('Connections'));
    await user.tab();
    expect(document.activeElement).toBe(row('Index'));
  });
});

describe('SettingsUnavailable, attack 371', () => {
  it('draws no list of sections', () => {
    render(
      <SettingsUnavailable onClose={vi.fn()}>
        <p>Could not load Settings.</p>
      </SettingsUnavailable>,
    );
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
    expect(screen.getByText('Could not load Settings.')).toBeTruthy();
  });
});

describe('SETTINGS_SECTIONS, attack 371', () => {
  it('gives every section a distinct id and title', () => {
    const all = Object.values(SETTINGS_SECTIONS);
    expect(new Set(all.map((section) => section.id)).size).toBe(all.length);
    expect(new Set(all.map((section) => section.title)).size).toBe(all.length);
  });
});
