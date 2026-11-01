// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  fakeGoogleCalendar,
  recordingActivity,
  createRefreshSpacing,
  createSourceRefresher,
  createTagRenames,
  fakeIndexPort,
  fakeVaultFs,
  VaultAccessError,
  type ApiBridgePort,
  type ApiRequest,
  type ApiResponse,
  createMeetingDrafts,
  type ApiRouterDeps,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useLocalApi } from './use-local-api.ts';

/** An open, empty vault that no pane is showing, whose creates land. */
function emptyVault(): ApiRouterDeps {
  const files = new Map<string, string>();
  return {
    host: {
      currentVault: () => ({ absolutePath: '/Users/j/Vault', name: 'Vault' }),
      indexReady: () => true,
    },
    appInfo: { read: async () => ({ name: 'DFAI', version: '1.0.0' }) },
    clock: { today: () => '2026-09-22', now: () => 1_000, localNow: () => '2026-09-22T09:00:00' },
    fs: fakeVaultFs({
      readTextFile: async (path) => {
        const text = files.get(path);
        if (text === undefined) throw new VaultAccessError('no such entry');
        return { text, modified: 1 };
      },
      createNote: async ({ path, contents }) => {
        files.set(path, contents);
        return 0;
      },
    }),
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

function handBridge() {
  let answer: ((request: ApiRequest) => Promise<ApiResponse>) | null = null;
  const stop = vi.fn();
  const bridge: ApiBridgePort = {
    serve: vi.fn(async (handler) => {
      answer = handler;
      return stop;
    }),
  };
  const create = (name: string) => {
    if (answer === null) throw new Error('nothing is serving');
    return answer({ id: name, method: 'POST', path: '/v1/notes', query: {}, body: { name } });
  };
  return { bridge, create, stop, serving: () => answer !== null };
}

describe('useLocalApi', () => {
  it('serves once, and tells the latest handler about a write', async () => {
    const deps = emptyVault();
    const hand = handBridge();
    const first = vi.fn();
    const latest = vi.fn();
    const view = renderHook(({ onWrote }) => useLocalApi({ bridge: hand.bridge, deps, onWrote }), {
      initialProps: { onWrote: first },
    });
    await waitFor(() => expect(hand.serving()).toBe(true));

    view.rerender({ onWrote: latest });
    const created = await hand.create('Fresh');

    expect(created.status).toBe(201);
    expect(hand.bridge.serve).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it('stops serving when the app goes away', async () => {
    const hand = handBridge();
    const view = renderHook(() =>
      useLocalApi({ bridge: hand.bridge, deps: emptyVault(), onWrote: () => {} }),
    );
    await waitFor(() => expect(hand.serving()).toBe(true));

    view.unmount();

    expect(hand.stop).toHaveBeenCalledOnce();
  });

  it('stops a listener that arrives after the app has already gone', async () => {
    const hand = handBridge();
    let arrive: (stop: () => void) => void = () => {};
    hand.bridge.serve = () => new Promise((resolve) => (arrive = resolve));
    const view = renderHook(() =>
      useLocalApi({ bridge: hand.bridge, deps: emptyVault(), onWrote: () => {} }),
    );

    view.unmount();
    arrive(hand.stop);
    await waitFor(() => expect(hand.stop).toHaveBeenCalledOnce());
  });

  it('carries on without the API when there is no host to listen to', async () => {
    const bridge: ApiBridgePort = { serve: vi.fn(async () => Promise.reject(new Error('no IPC'))) };
    const view = renderHook(() => useLocalApi({ bridge, deps: emptyVault(), onWrote: () => {} }));
    await waitFor(() => expect(bridge.serve).toHaveBeenCalledOnce());
    expect(() => view.unmount()).not.toThrow();
  });
});
