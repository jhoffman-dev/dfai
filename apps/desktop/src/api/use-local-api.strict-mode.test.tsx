// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  API_REQUEST_EVENT,
  createRefreshSpacing,
  createSourceRefresher,
  createTagRenames,
  fakeGoogleCalendar,
  fakeIndexPort,
  fakeVaultFs,
  recordingActivity,
  createMeetingDrafts,
  type ApiRouterDeps,
} from '@dfai/application';
import { remarkMarkdown, tauriApiBridge } from '@dfai/adapters';
import { useLocalApi } from './use-local-api.ts';

/**
 * Issue #158: `main.tsx` renders the app in React StrictMode, which mounts
 * `useLocalApi` twice and abandons the first. The real bridge runs here against
 * a host that behaves as the Rust one does — ready while any listener it was
 * told about is live, forwarding each request to every event listener — so the
 * test sees what a request from outside the app would.
 */

type Handler = (event: { payload: unknown }) => void;

const host = vi.hoisted(() => {
  const state = {
    /** Listeners the host was told are ready, by the id each named. */
    ready: new Set<unknown>(),
    /** Event listeners registered for API requests. */
    handlers: new Set<(event: { payload: unknown }) => void>(),
    /** `api_router_ready` calls the host has applied but not yet answered. */
    unanswered: [] as (() => void)[],
    holdAnswers: false,
    responses: [] as unknown[],
  };
  return state;
});

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invoke: async (command: string, args: { listener?: unknown; ready?: boolean }) => {
    if (command === 'api_respond') {
      host.responses.push(args);
      return null;
    }
    if (command !== 'api_router_ready') throw new Error(`no host command ${command} here`);
    if (args.ready) host.ready.add(args.listener);
    else host.ready.delete(args.listener);
    if (!host.holdAnswers) return null;
    return new Promise<null>((resolve) => host.unanswered.push(() => resolve(null)));
  },
}));

vi.mock('@tauri-apps/api/event', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listen: async (event: string, handler: Handler) => {
    if (event !== API_REQUEST_EVENT) throw new Error(`no event ${event} here`);
    host.handlers.add(handler);
    return () => void host.handlers.delete(handler);
  },
}));

/** What the Rust gate does with a request: refuse it at once, or forward it. */
function sendRequest(payload: unknown): 'refused: still starting' | 'forwarded' {
  if (host.ready.size === 0) return 'refused: still starting';
  for (const handler of host.handlers) handler({ payload });
  return 'forwarded';
}

function emptyVault(): ApiRouterDeps {
  return {
    host: {
      currentVault: () => ({ absolutePath: '/Users/j/Vault', name: 'Vault' }),
      indexReady: () => true,
    },
    appInfo: { read: async () => ({ name: 'DFAI', version: '1.0.0' }) },
    clock: { today: () => '2026-09-22', now: () => 1_000, localNow: () => '2026-09-22T09:00:00' },
    fs: fakeVaultFs(),
    markdown: remarkMarkdown,
    index: fakeIndexPort(),
    openNotes: { state: () => 'closed', setPropertiesIfOpen: async () => false, reload: () => {} },
    movingNotes: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
    thumbnails: { requestOrFail: () => Promise.reject(new Error('no pictures here')) },
    sources: {
      http: { get: () => Promise.reject(new Error('no feeds here')) },
      sqlite: { query: () => Promise.reject(new Error('no SQLite files here')) },
    },
    imagePlacement: () => 'attachments',
    sourceRefresher: createSourceRefresher({ activity: recordingActivity() }),
    tagRenames: createTagRenames(),
    refreshSpacing: createRefreshSpacing(),
    newUploadId: () => 'upload-1',
    rng: { next: () => 0.5 },
    automationClock: { forVault: () => null },
    activity: recordingActivity(),
    googleCalendar: fakeGoogleCalendar().port,
    timeZone: () => 'America/Los_Angeles',
    meetingDrafts: createMeetingDrafts(),
    notices: { warn: () => {} },
  };
}

function resetHost(holdAnswers: boolean): void {
  host.ready.clear();
  host.handlers.clear();
  host.unanswered.length = 0;
  host.holdAnswers = holdAnswers;
  host.responses.length = 0;
}

/** Answers the held `api_router_ready` calls, the last made first. */
async function answerLastFirst(count: number): Promise<void> {
  await waitFor(() => expect(host.unanswered).toHaveLength(count));
  const held = host.unanswered.splice(0).reverse();
  host.holdAnswers = false;
  held.forEach((answer) => answer());
}

describe('useLocalApi under React StrictMode (issue #158)', () => {
  it.each([
    ['answered at once', false],
    ['answered last first', true],
  ])(
    'leaves one listener serving and the host ready once the double mount settles (%s)',
    async (_answers, holdAnswers) => {
      resetHost(holdAnswers);
      const deps = emptyVault();
      const view = renderHook(
        () => useLocalApi({ bridge: tauriApiBridge, deps, onWrote: () => {} }),
        // As `main.tsx` renders it: StrictMode at the root. (A `wrapper` holding
        // <StrictMode> does not run effects twice under React 19.)
        { reactStrictMode: true },
      );
      if (holdAnswers) await answerLastFirst(2);

      // The abandoned mount has stopped and the live one is the only listener.
      await waitFor(() => expect(host.handlers.size).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(host.ready.size, 'the live listener lost its readiness').toBe(1);
      expect(
        sendRequest({ id: 'r1', method: 'GET', path: '/v1/status', query: {}, body: null }),
      ).toBe('forwarded');
      await waitFor(() =>
        expect(host.responses).toEqual([expect.objectContaining({ id: 'r1', status: 200 })]),
      );

      view.unmount();
      await waitFor(() => expect(host.ready.size).toBe(0));
      expect(host.handlers.size).toBe(0);
    },
  );
});
