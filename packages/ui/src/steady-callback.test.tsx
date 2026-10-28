// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { memo } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, todayLists, type ReviewTask } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { useSteadyCallback } from './steady-callback.ts';
import { TodayPage, type TodayPageProps } from './today-page.tsx';

/** A memoised child, so the one handed the steady callback is drawn only once. */
const Press = memo(function Press({ onPress }: { onPress: () => void }) {
  return (
    <button type="button" onClick={onPress}>
      Press
    </button>
  );
});

function Holder({ act }: { act: () => void }) {
  const steady = useSteadyCallback(act);
  return <Press onPress={steady} />;
}

describe('useSteadyCallback', () => {
  it('calls the callback of the latest render, not the one it was first made with', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<Holder act={first} />);
    view.rerender(<Holder act={latest} />);

    fireEvent.click(screen.getByRole('button', { name: 'Press' }));

    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('hands over the same function from one render to the next', () => {
    const seen: (() => void)[] = [];
    function Watch({ act }: { act: () => void }) {
      seen.push(useSteadyCallback(act));
      return null;
    }
    const view = render(<Watch act={vi.fn()} />);
    view.rerender(<Watch act={vi.fn()} />);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });
});

describe('useSteadyCallback, through the Today page', () => {
  const NOW = Date.UTC(2026, 9, 13, 15);
  const path = createVaultPath('Tasks/Call the bank.md');
  const task: ReviewTask = {
    path,
    title: 'Call the bank',
    status: 'next-action',
    due: null,
    defer: null,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: NOW,
  };
  const today: TodayReport = {
    ...todayLists({ tasks: [task], projects: [], at: { today: '2026-10-13', now: NOW } }),
    today: '2026-10-13',
    choosing: true,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
    stalledProjects: 0,
  };
  const props = (onDone: TodayPageProps['onDone']): TodayPageProps => ({
    today,
    error: null,
    busy: false,
    problem: null,
    view: null,
    onOpen: vi.fn(),
    onOpenInbox: vi.fn(),
    onOpenReview: vi.fn(),
    onOpenDailyNote: vi.fn(),
    onDone,
    onSetStatus: vi.fn(),
    onDefer: vi.fn(),
    onChoose: vi.fn(),
  });

  it('ticks through the onDone the app handed over last', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<TodayPage {...props(first)} />);
    view.rerender(<TodayPage {...props(latest)} />);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Call the bank done' }));

    expect(latest).toHaveBeenCalledWith({ path, title: 'Call the bank' });
    expect(first).not.toHaveBeenCalled();
  });
});
