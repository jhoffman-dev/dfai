// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { EVERY_ENTRY_POINT, type EntryPointsOffered } from '@dfai/application';
import { DESKTOP_CAPABILITIES, WEB_CAPABILITIES } from '@dfai/domain';
import { composedForApp, mountShell, type AppPorts } from './mount-shell.tsx';

/** What the stand-in app was last handed: what it offers, and which ports. */
const handed = vi.hoisted(() => ({
  offered: null as EntryPointsOffered | null,
  ports: [] as string[],
}));

// mountShell's own work, without the window it draws: the app and its later pages stand in.
vi.mock('./app.tsx', () => ({
  App: ({ offered, ...ports }: { offered: EntryPointsOffered }) => {
    handed.offered = offered;
    handed.ports = Object.keys(ports).sort();
    return <p>the app</p>;
  },
}));
vi.mock('./pages-on-first-use.ts', () => ({ preloadPages: async () => {} }));

/**
 * Never read: the app that would read them is the stand-in above. Each port
 * a composition may leave out is here, as the desktop hands them all in.
 */
const ports = {
  appInfo: {},
  kindle: {},
  semantic: {},
  exporting: {},
  meetings: {},
  blocks: {},
} as unknown as AppPorts;

/** Which of the ports a composition may leave out reach the app. */
const optional = (handedPorts: AppPorts) =>
  (['kindle', 'semantic', 'exporting', 'meetings', 'blocks'] as const).filter(
    (name) => handedPorts[name] !== undefined,
  );

/** A file dragged in from the Finder, as the webview would navigate to it. */
function fileDrop(): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  return Object.assign(event, { dataTransfer: { types: ['Files'], dropEffect: 'copy' } });
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = '';
});

const mounted = () => {
  document.body.innerHTML = '<div id="root"></div>';
  unmount = mountShell({ ports, capabilities: DESKTOP_CAPABILITIES });
};

describe('mountShell (#656)', () => {
  it('says so when the page has nowhere to draw the app', () => {
    document.body.innerHTML = '<main></main>';
    expect(() => mountShell({ ports, capabilities: DESKTOP_CAPABILITIES })).toThrow(
      'index.html is missing #root',
    );
  });

  it('draws the app into #root and takes it down again', async () => {
    mounted();
    expect(await screen.findByText('the app')).toBeDefined();
    unmount?.();
    unmount = null;
    await waitFor(() => expect(document.getElementById('root')?.childElementCount).toBe(0));
  });

  it('refuses a file dropped on the page while it holds the app, and not after', async () => {
    mounted();
    await screen.findByText('the app');
    const held = fileDrop();
    document.body.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    unmount?.();
    unmount = null;
    const after = fileDrop();
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('refuses a second app on a page that holds one, and takes one again once it is down', () => {
    mounted();
    expect(() => mountShell({ ports, capabilities: DESKTOP_CAPABILITIES })).toThrow(
      'this page already holds the app',
    );
    unmount?.();
    unmount = null;
    expect(() => mounted()).not.toThrow();
  });

  it('hands the app every entry point on the desktop (#657)', async () => {
    mounted();
    await screen.findByText('the app');
    expect(handed.offered).toEqual(EVERY_ENTRY_POINT);
  });

  it('hands the app what the platform offers, and none of the ports it lacks (#657)', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    unmount = mountShell({ ports, capabilities: WEB_CAPABILITIES });
    await screen.findByText('the app');
    expect(handed.offered?.kindleSettings).toBe(false);
    expect(handed.offered?.syncSettings).toBe(false);
    expect(handed.offered?.exportNotes).toBe(true);
    expect(handed.ports).toEqual(['appInfo', 'exporting']);
  });
});

describe('composedForApp, the calendar’s two syncs (#699 attack)', () => {
  const offeredWithout = (left: readonly string[]) =>
    composedForApp({
      ports: Object.fromEntries(
        Object.entries(ports).filter(([name]) => !left.includes(name)),
      ) as unknown as AppPorts,
      capabilities: DESKTOP_CAPABILITIES,
    }).offered;

  it('keeps Settings → Google Calendar while either sync has its port', () => {
    expect(offeredWithout(['meetings']).googleCalendarSettings).toBe(true);
    expect(offeredWithout(['blocks']).googleCalendarSettings).toBe(true);
  });

  it('offers no Settings → Google Calendar once neither sync has its port', () => {
    const offered = offeredWithout(['meetings', 'blocks']);
    expect([offered.meetingSync, offered.blockSync, offered.googleCalendarSettings]).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('composedForApp (#657)', () => {
  it('hands the desktop every port and every entry point', () => {
    const composed = composedForApp({ ports, capabilities: DESKTOP_CAPABILITIES });
    expect(composed.offered).toEqual(EVERY_ENTRY_POINT);
    expect(optional(composed.ports)).toEqual([
      'kindle',
      'semantic',
      'exporting',
      'meetings',
      'blocks',
    ]);
  });

  it.each([
    ['kindle', 'kindle', ['kindleSettings', 'kindleCommands']],
    ['localModels', 'semantic', ['meaningSearch']],
    ['markdownExport', 'exporting', ['exportNotes', 'pdfExport', 'googleDocExport']],
  ] as const)(
    'takes %s as off where its port is left out, and offers nothing that needs it',
    (_capability, port, entries) => {
      const without = Object.fromEntries(Object.entries(ports).filter(([name]) => name !== port));
      const composed = composedForApp({
        ports: without as unknown as AppPorts,
        capabilities: DESKTOP_CAPABILITIES,
      });
      for (const entry of entries) expect(composed.offered[entry]).toBe(false);
      expect(optional(composed.ports)).not.toContain(port);
    },
  );

  it.each([
    ['kindle', ['kindle']],
    ['localModels', ['semantic']],
    ['markdownExport', ['exporting']],
    ['googleCalendar', ['meetings', 'blocks']],
  ] as const)('hands on no port for %s once it is off, though it was given', (capability, gone) => {
    const composed = composedForApp({
      ports,
      capabilities: { ...DESKTOP_CAPABILITIES, [capability]: false },
    });
    for (const port of gone) expect(optional(composed.ports)).not.toContain(port);
    expect(optional(composed.ports)).toHaveLength(5 - gone.length);
  });
});
