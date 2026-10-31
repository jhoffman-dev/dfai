// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { memoryActivityStore, recordingActivity, type WindowClosingPort } from '@dfai/application';
import { useActivityLog, useNoticeActivity } from './use-activity-log.ts';

const VAULT = '/Users/j/Vault';

describe('useNoticeActivity', () => {
  it('records each red notice once as it appears, and again only after it went away', () => {
    const activity = recordingActivity();
    const hook = renderHook(
      (props: { notices: (string | null)[] }) =>
        useNoticeActivity({ errors: props.notices, warnings: [] }, activity),
      { initialProps: { notices: [null, null] as (string | null)[] } },
    );
    expect(activity.reports).toEqual([]);

    hook.rerender({ notices: ['The sidebar could not be saved', null] });
    hook.rerender({ notices: ['The sidebar could not be saved', null] });
    hook.rerender({ notices: ['The sidebar could not be saved', 'The index failed'] });
    hook.rerender({ notices: [null, 'The index failed'] });
    hook.rerender({ notices: ['The sidebar could not be saved', 'The index failed'] });

    expect(activity.reports.map((report) => report.message)).toEqual([
      'The sidebar could not be saved',
      'The index failed',
      'The sidebar could not be saved',
    ]);
    expect(
      activity.reports.every((report) => report.level === 'error' && report.kind === 'app'),
    ).toBe(true);
  });

  it('records a warning notice as a warning', () => {
    const activity = recordingActivity();
    const hook = renderHook(
      (props: { warning: string | null }) =>
        useNoticeActivity({ errors: [], warnings: [props.warning] }, activity),
      { initialProps: { warning: null as string | null } },
    );
    hook.rerender({ warning: 'Unsaved changes to Plan could not be saved.' });
    expect(activity.reports).toEqual([
      {
        level: 'warning',
        kind: 'app',
        message: 'Unsaved changes to Plan could not be saved.',
        subject: null,
      },
    ]);
  });
});

/** Lets the in-memory store's writes, which wait on no timer, finish. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** A window whose close can be asked for by the test, as the close button would. */
function closableWindow() {
  let task: (() => Promise<void>) | null = null;
  const stop = vi.fn();
  const closing: WindowClosingPort = {
    beforeClose: async (next) => {
      task = next;
      return stop;
    },
  };
  return { closing, stop, close: () => task?.() ?? Promise.resolve() };
}

describe('useActivityLog', () => {
  it('keeps one log for the window', () => {
    const store = memoryActivityStore();
    const { closing } = closableWindow();
    const hook = renderHook(
      (props: { vault: string | null }) =>
        useActivityLog({ store, vaultKey: props.vault, closing }),
      { initialProps: { vault: VAULT } },
    );
    const first = hook.result.current;
    hook.rerender({ vault: VAULT });
    expect(hook.result.current).toBe(first);
  });

  it('writes what waits when the window is closed, without waiting for the timer', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryActivityStore();
      const closable = closableWindow();
      const hook = renderHook(() =>
        useActivityLog({ store, vaultKey: VAULT, closing: closable.closing }),
      );
      hook.result.current.record({ level: 'error', kind: 'app', message: 'late', subject: null });
      expect(store.files.get(VAULT) ?? '').toBe('');
      await closable.close();
      expect(store.files.get(VAULT)).toContain('late');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes what waits when the page unloads, without waiting for the timer', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryActivityStore();
      const { closing } = closableWindow();
      const hook = renderHook(() => useActivityLog({ store, vaultKey: VAULT, closing }));
      hook.result.current.record({
        level: 'info',
        kind: 'app',
        message: 'on unload',
        subject: null,
      });
      window.dispatchEvent(new Event('beforeunload'));
      await settled();
      expect(store.files.get(VAULT)).toContain('on unload');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops listening for the close once the window lets it go', async () => {
    const store = memoryActivityStore();
    const closable = closableWindow();
    const hook = renderHook(() =>
      useActivityLog({ store, vaultKey: VAULT, closing: closable.closing }),
    );
    hook.unmount();
    await vi.waitFor(() => expect(closable.stop).toHaveBeenCalledTimes(1));
  });
});
