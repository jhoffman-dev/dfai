// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GlobalCapturePort } from '@dfai/application';
import { createBrowserGlobalCaptureStore } from './browser-global-capture-store.ts';
import { useGlobalCapture } from './use-global-capture.ts';

/** #81: the global capture shortcut, handed to the host and heard back from it. */

/** A host that registers anything it is asked to, except what `refuse` names, and lets a test press. */
function fakeHost(refuse: (shortcut: string) => string | null = () => null) {
  const asked: (string | null)[] = [];
  const listeners: (() => void)[] = [];
  const stopped = vi.fn();
  const port: GlobalCapturePort = {
    status: async () => ({ shortcut: null, registered: false, problem: null }),
    set: async (shortcut) => {
      asked.push(shortcut);
      const refusal = shortcut === null ? null : refuse(shortcut);
      if (refusal !== null) throw new Error(refusal);
      return { shortcut, registered: shortcut !== null, problem: null };
    },
    listen: async (pressed) => {
      listeners.push(pressed);
      return stopped;
    },
  };
  return { port, asked, stopped, press: () => listeners.forEach((pressed) => pressed()) };
}

afterEach(() => window.localStorage.clear());

describe('useGlobalCapture', () => {
  it('hands the host ⌃⌥N as the app starts on a Mac that chose nothing', async () => {
    const host = fakeHost();
    const hook = renderHook(() =>
      useGlobalCapture({
        port: host.port,
        store: createBrowserGlobalCaptureStore(),
        pressed: vi.fn(),
      }),
    );
    await waitFor(() =>
      expect(hook.result.current.status).toEqual({
        shortcut: 'Control+Alt+KeyN',
        registered: true,
        problem: null,
      }),
    );
    expect(host.asked).toEqual(['Control+Alt+KeyN']);
  });

  it('hands the host what this Mac chose, and nothing when it was turned off', async () => {
    window.localStorage.setItem('atlas.globalCaptureShortcut', 'Control+Super+KeyK');
    const chosen = fakeHost();
    renderHook(() =>
      useGlobalCapture({
        port: chosen.port,
        store: createBrowserGlobalCaptureStore(),
        pressed: vi.fn(),
      }),
    );
    await waitFor(() => expect(chosen.asked).toEqual(['Control+Super+KeyK']));

    window.localStorage.setItem('atlas.globalCaptureShortcut', 'off');
    const off = fakeHost();
    renderHook(() =>
      useGlobalCapture({
        port: off.port,
        store: createBrowserGlobalCaptureStore(),
        pressed: vi.fn(),
      }),
    );
    await waitFor(() => expect(off.asked).toEqual([null]));
  });

  it('keeps a change for next time and registers it now', async () => {
    const host = fakeHost();
    const store = createBrowserGlobalCaptureStore();
    const hook = renderHook(() => useGlobalCapture({ port: host.port, store, pressed: vi.fn() }));
    await waitFor(() => expect(hook.result.current.status).not.toBeNull());

    act(() => hook.result.current.change('Alt+Super+KeyJ'));

    await waitFor(() => expect(hook.result.current.status?.shortcut).toBe('Alt+Super+KeyJ'));
    expect(host.asked).toEqual(['Control+Alt+KeyN', 'Alt+Super+KeyJ']);
    expect(window.localStorage.getItem('atlas.globalCaptureShortcut')).toBe('Alt+Super+KeyJ');
  });

  it("shows the host's refusal rather than a shortcut that is not registered", async () => {
    const host = fakeHost((shortcut) =>
      shortcut === 'KeyN'
        ? 'KeyN does not hold two of ⌘, ⌥ and ⌃, so it would take its key from every other app'
        : null,
    );
    const hook = renderHook(() =>
      useGlobalCapture({
        port: host.port,
        store: createBrowserGlobalCaptureStore(),
        pressed: vi.fn(),
      }),
    );
    await waitFor(() => expect(hook.result.current.status?.registered).toBe(true));

    act(() => hook.result.current.change('KeyN'));

    await waitFor(() =>
      expect(hook.result.current.status).toEqual({
        shortcut: 'KeyN',
        registered: false,
        problem:
          'KeyN does not hold two of ⌘, ⌥ and ⌃, so it would take its key from every other app',
      }),
    );
  });

  it('calls the latest handler on each press, and stops listening when the window goes', async () => {
    const host = fakeHost();
    const first = vi.fn();
    const latest = vi.fn();
    const hook = renderHook(
      ({ pressed }) =>
        useGlobalCapture({ port: host.port, store: createBrowserGlobalCaptureStore(), pressed }),
      { initialProps: { pressed: first } },
    );
    await waitFor(() => expect(hook.result.current.status).not.toBeNull());
    hook.rerender({ pressed: latest });

    host.press();

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(host.stopped).toHaveBeenCalledTimes(1);
  });
});
