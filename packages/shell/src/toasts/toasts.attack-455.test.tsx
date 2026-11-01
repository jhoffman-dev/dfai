// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createToasts, MAX_TOASTS } from './toasts.ts';
import { ToastHost } from './toast-host.tsx';

/**
 * Attack on PR #455 (#320): "warnings and errors also go to Activity so a
 * missed toast can be found later". ToastHost records them in an effect
 * over the queue it last drew, so a warning that is pushed out of the
 * queue (MAX_TOASTS) before the host draws again is never recorded.
 */
describe('the toasts and Activity (attack-455)', () => {
  it('records a warning in Activity even when newer toasts push it out before the next draw', () => {
    const toasts = createToasts();
    const activity = { record: vi.fn() };
    render(<ToastHost toasts={toasts} activity={activity} />);

    act(() => {
      toasts.show({
        message: '“A” has changed since, so the change was not undone.',
        tone: 'warning',
      });
      for (let each = 0; each < MAX_TOASTS; each += 1) {
        toasts.show({ message: `Changed “Row ${each}”.`, tone: 'change' });
      }
    });

    expect(activity.record.mock.calls.map(([report]) => report.message)).toEqual([
      '“A” has changed since, so the change was not undone.',
    ]);
  });
});
