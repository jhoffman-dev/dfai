// @vitest-environment jsdom
/**
 * Attack on PR #592 (#587): Today's meetings on the calendar's day. The
 * calendar's midnight is not the Mac's, so the page's own day does not turn
 * when the calendar's does; the list must turn by itself. Fictional data only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { fakeIndexPort, fakeVaultFs } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useTodaysMeetings } from './use-todays-meetings.ts';

const VAULT = '/Users/mara/Vault';

const settings = fakeVaultFs({
  readNotes: async (paths) =>
    paths.includes('.atlas/settings.md')
      ? [
          {
            path: '.atlas/settings.md',
            text: '---\ngoogle_meetings: true\ngoogle_plan_zone: Asia/Tokyo\n---\n',
            modified: 1,
            size: 1,
          },
        ]
      : [],
});

const index = () =>
  fakeIndexPort({
    query: vi.fn(async () => ({
      columns: ['path', 'title', 'key', 'value'],
      rows: [],
      truncated: false,
    })),
  });

const daysAsked = (port: ReturnType<typeof index>) =>
  vi.mocked(port.query).mock.calls.map(([, parameters]) => parameters);

afterEach(() => {
  vi.useRealTimers();
});

describe('attack #592: Today’s meetings across the calendar’s midnight', () => {
  it('turns to the calendar’s new day while the page’s own day stays the same', async () => {
    vi.useFakeTimers();
    // 07:30 on the 24th in Los Angeles; 23:30 on the 24th in Tokyo.
    let now = Date.parse('2026-10-24T14:30:00Z');
    const port = index();
    renderHook(
      () =>
        useTodaysMeetings({
          fs: settings,
          markdown: remarkMarkdown,
          index: port,
          vault: VAULT,
          day: '2026-10-24',
          clock: { now: () => now },
          indexReady: true,
        }),
      { wrapper: queryWrapper().wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(daysAsked(port).some((parameters) => parameters?.includes('2026-10-24'))).toBe(true);
    // An hour on: 08:30 in Los Angeles, the page still on the 24th; 00:30 on the 25th in Tokyo.
    now += 60 * 60_000;
    await act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
    expect(daysAsked(port).some((parameters) => parameters?.includes('2026-10-25'))).toBe(true);
  });
});
