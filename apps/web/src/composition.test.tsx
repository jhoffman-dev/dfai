// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mountShell, type AppPorts } from '@dfai/shell';
import { composeWeb, composeWebShell } from './composition.ts';

/*
 * #656: the web build composes the same shell as the desktop, on no host at
 * all. Started as main.ts starts it, the window opens the sample vault and
 * lists its notes, so the seam carries everything the shell needs.
 */

// The shortcuts read the platform; jsdom's is none.
beforeAll(() => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'));

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

const startedAsMainStartsIt = () => {
  document.body.innerHTML = '<div id="root"></div>';
  unmount = mountShell(composeWebShell());
};

/** The web build started, its sample vault open and listed. */
const opened = async () => {
  startedAsMainStartsIt();
  await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
};

/**
 * Settings asked for with ⌘, and drawn: whatever a key or a paste before it
 * set going has been drawn too, so what it would have shown can be looked for.
 */
const afterWhatCameBefore = async () => {
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  await screen.findByRole('dialog', {}, { timeout: 10_000 });
};

/** `call`, telling `tell` each time it is called. */
function watch<Args extends unknown[], Result>(
  tell: () => void,
  call: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    tell();
    return call(...args);
  };
}

/** `port`, telling `tell` each time any of its methods is called. */
function watchEvery<Port extends object>(tell: () => void, port: Port): Port {
  return new Proxy(port, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        tell();
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/** A message's link, as Slack's "Copy link" gives it. */
const SLACK_LINK = 'https://larkspur.slack.com/archives/C0123ABCD/p1793136000000100';

describe('the web build (#656)', () => {
  it('draws the shell on the sample vault, listing its notes', { timeout: 20_000 }, async () => {
    startedAsMainStartsIt();
    expect(
      await screen.findByRole('treeitem', { name: 'Larkspur garden' }, { timeout: 10_000 }),
    ).toBeDefined();
    expect(screen.getByRole('treeitem', { name: 'Welcome' })).toBeDefined();
  });

  it(
    'hides what a browser cannot do, from the capabilities it is handed (#657)',
    {
      timeout: 20_000,
    },
    async () => {
      startedAsMainStartsIt();
      await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
      // The desktop's sidebar has Ask beside Search, and a sync light by Settings.
      expect(screen.queryByTitle('Ask (⌘J)')).toBeNull();
      expect(screen.queryByLabelText(/^Sync:/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      const sections = await screen.findByRole('navigation', { name: 'Settings sections' });
      expect(
        within(sections)
          .getAllByRole('button')
          .map((link) => link.textContent),
      ).toEqual(['Appearance', 'Profile', 'Index', 'Images', 'Quick add', 'About']);
      expect(screen.queryByRole('switch', { name: 'Local API' })).toBeNull();
    },
  );

  it(
    'draws no section in Settings that a browser cannot use (#657)',
    { timeout: 20_000 },
    async () => {
      await opened();
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      const settings = await screen.findByRole('dialog', {}, { timeout: 10_000 });
      // Every section that is drawn, drawn first: what is left out has had its chance to load.
      for (const title of ['Appearance', 'Profile', 'Index', 'Images', 'Quick add', 'About']) {
        await within(settings).findByRole('heading', { name: title }, { timeout: 10_000 });
      }
      const drawn = within(settings)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);
      for (const title of [
        'Connections',
        'Quick capture from anywhere',
        'Secrets',
        'Google Calendar',
        'Granola',
        'Slack',
        'Kindle',
        'Claude',
        'Sync',
      ]) {
        expect(drawn).not.toContain(title);
      }
    },
  );

  it('opens neither Claude nor Ask from their shortcuts (#657)', { timeout: 20_000 }, async () => {
    await opened();
    const tabNames = () =>
      screen.queryAllByRole('tab', { hidden: true }).map((tab) => tab.textContent);
    const tabsBefore = tabNames();
    expect(tabsBefore.length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: 'j', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    await afterWhatCameBefore();
    // What either would open, looked for under Settings too: the chat, the aside it sits in, or Ask's tab.
    const hidden = { hidden: true } as const;
    expect(screen.queryByRole('complementary', { name: 'Claude', ...hidden })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Right sidebar', ...hidden })).toBeNull();
    // Ask opens in the tab at hand: its name would say so.
    expect(tabNames()).toEqual(tabsBefore);
  });

  it(
    'lists no Kindle command and no search by meaning in ⌘K (#657)',
    { timeout: 20_000 },
    async () => {
      await opened();
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      const search = await screen.findByRole(
        'searchbox',
        { name: 'Search the vault' },
        { timeout: 10_000 },
      );
      fireEvent.change(search, { target: { value: 'kindle' } });
      // The library's own command names Kindle among its words: the palette has answered once it shows.
      await screen.findByRole('option', { name: /Library/ }, { timeout: 10_000 });
      expect(screen.queryByRole('option', { name: /Connect Kindle/ })).toBeNull();
      expect(screen.queryByRole('switch', { name: 'By meaning' })).toBeNull();
    },
  );

  it('offers nothing for a pasted Slack link (#657)', { timeout: 20_000 }, async () => {
    await opened();
    const field = document.createElement('div');
    field.setAttribute('data-paste-offers', '');
    document.body.append(field);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { getData: () => SLACK_LINK } });
    field.dispatchEvent(paste);
    await afterWhatCameBefore();
    expect(screen.queryByRole('region', { name: 'Slack message', hidden: true })).toBeNull();
    expect(paste.defaultPrevented).toBe(false);
  });

  it(
    'runs nothing in the background for what a browser lacks (#657)',
    { timeout: 20_000 },
    async () => {
      const ports = composeWeb();
      const asked: string[] = [];
      const told = (what: string) => () => void asked.push(what);
      const shell = composeWebShell();
      const watched: AppPorts = {
        ...ports,
        granola: {
          ...ports.granola,
          port: {
            ...ports.granola.port,
            status: watch(told('granola key'), ports.granola.port.status),
          },
        },
        globalCapture: {
          ...ports.globalCapture,
          port: {
            ...ports.globalCapture.port,
            set: watch(told('shortcut registered'), ports.globalCapture.port.set),
            listen: watch(told('shortcut heard'), ports.globalCapture.port.listen),
          },
        },
        api: {
          ...ports.api,
          bridge: { serve: watch(told('local API served'), ports.api.bridge.serve) },
        },
        sync: {
          ...ports.sync,
          git: (vault) => watchEvery(told('git asked'), ports.sync.git(vault)),
        },
      };
      document.body.innerHTML = '<div id="root"></div>';
      unmount = mountShell({ ...shell, ports: watched });
      await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
      await afterWhatCameBefore();
      expect(asked).toEqual([]);
    },
  );

  it('takes the window down again when asked', { timeout: 20_000 }, async () => {
    startedAsMainStartsIt();
    await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
    unmount?.();
    unmount = null;
    await waitFor(() => expect(document.getElementById('root')?.childElementCount).toBe(0));
  });
});
