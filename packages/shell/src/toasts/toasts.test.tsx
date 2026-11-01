// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createToasts, MAX_TOASTS } from './toasts.ts';
import { ToastHost } from './toast-host.tsx';

/** #320: the window's toasts — a queue held outside the pages, five seconds each, with Undo. */
afterEach(() => {
  vi.useRealTimers();
});

const said = (toasts: ReturnType<typeof createToasts>) =>
  toasts.store.getState().toasts.map((toast) => toast.message);

describe('the toasts', () => {
  it('queues each toast shown, oldest first, each with its own id', () => {
    const toasts = createToasts();
    const first = toasts.show({ message: 'Finished “Water the beds”.', tone: 'change' });
    const second = toasts.show({ message: 'Finished “Water the beds”.', tone: 'change' });
    expect(first).not.toBe(second);
    expect(said(toasts)).toEqual(['Finished “Water the beds”.', 'Finished “Water the beds”.']);
  });

  it('keeps a few at most, letting the oldest go first', () => {
    const toasts = createToasts();
    const gone = vi.fn();
    toasts.show({ message: 'first', tone: 'change', onGone: gone });
    for (let at = 1; at <= MAX_TOASTS; at += 1)
      toasts.show({ message: `then ${at}`, tone: 'change' });
    expect(said(toasts)).toHaveLength(MAX_TOASTS);
    expect(said(toasts)).not.toContain('first');
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('puts a slot’s new toast in place of its last: one surface, one last change', () => {
    const toasts = createToasts();
    const gone = vi.fn();
    toasts.show({ message: 'Finished “A”.', tone: 'change', slot: 'today', onGone: gone });
    toasts.show({ message: 'Moved “B” to Done.', tone: 'change' });
    toasts.show({ message: 'Finished “C”.', tone: 'change', slot: 'today' });
    expect(said(toasts)).toEqual(['Moved “B” to Done.', 'Finished “C”.']);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('says when a toast has gone, once, however it went', () => {
    const toasts = createToasts();
    const gone = vi.fn();
    const id = toasts.show({ message: 'x', tone: 'change', onGone: gone });
    toasts.dismiss(id);
    toasts.dismiss(id);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(said(toasts)).toEqual([]);
  });
});

describe('ToastHost', () => {
  it('draws the queue, and Undo undoes that change and lets its toast go', () => {
    const toasts = createToasts();
    const undo = vi.fn();
    const activity = { record: vi.fn() };
    render(<ToastHost toasts={toasts} activity={activity} />);
    act(
      () =>
        void toasts.show({ message: 'Finished “Water the beds”.', tone: 'change', onUndo: undo }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(undo).toHaveBeenCalledTimes(1);
    expect(said(toasts)).toEqual([]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('lets a toast go after five seconds', () => {
    vi.useFakeTimers();
    const toasts = createToasts();
    render(<ToastHost toasts={toasts} activity={{ record: vi.fn() }} />);
    act(() => void toasts.show({ message: 'Finished “A”.', tone: 'change' }));
    act(() => vi.advanceTimersByTime(4999));
    expect(said(toasts)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(said(toasts)).toEqual([]);
  });

  it('records a warning and an error in Activity as each appears, and never a change', () => {
    const toasts = createToasts();
    const activity = { record: vi.fn() };
    const { rerender } = render(<ToastHost toasts={toasts} activity={activity} />);
    act(() => {
      toasts.show({ message: 'Finished “A”.', tone: 'change' });
      toasts.show({
        message: '“A” has changed since, so the change was not undone.',
        tone: 'warning',
      });
      toasts.show({ message: 'The disk is full.', tone: 'error' });
    });
    rerender(<ToastHost toasts={toasts} activity={activity} />);

    expect(activity.record.mock.calls.map(([report]) => [report.level, report.message])).toEqual([
      ['warning', '“A” has changed since, so the change was not undone.'],
      ['error', 'The disk is full.'],
    ]);
  });
});

describe('the toasts and another vault (#455)', () => {
  it('lets every toast go when another vault opens, telling each it has gone', () => {
    const toasts = createToasts();
    const gone = vi.fn();
    const activity = { record: vi.fn() };
    const { rerender } = render(
      <ToastHost toasts={toasts} activity={activity} vault="/vaults/a" />,
    );
    act(() => void toasts.show({ message: 'Finished “A”.', tone: 'change', onGone: gone }));
    rerender(<ToastHost toasts={toasts} activity={activity} vault="/vaults/a" />);
    expect(said(toasts)).toHaveLength(1);

    rerender(<ToastHost toasts={toasts} activity={activity} vault="/vaults/b" />);

    expect(said(toasts)).toEqual([]);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('changes nothing, and draws nothing, when none is up or the vault is the same', () => {
    const toasts = createToasts();
    const before = toasts.store.getState();
    toasts.openVault('/vaults/a');
    expect(toasts.store.getState()).toBe(before);
    toasts.show({ message: 'x', tone: 'change' });
    toasts.openVault('/vaults/a');
    expect(said(toasts)).toEqual(['x']);
    expect(toasts.vaultNow()).toBe('/vaults/a');
  });
});

describe('the toasts, placed in the topmost modal layer (#468)', () => {
  const activity = { record: vi.fn() };

  it('draws them in the place a modal layer hands over, and back in the window once it goes', () => {
    const toasts = createToasts();
    toasts.show({ message: 'Changed “Order chairs”.', tone: 'change', onUndo: () => {} });
    const place = document.createElement('div');
    document.body.append(place);
    render(<ToastHost toasts={toasts} activity={activity} />);
    expect(place.querySelector('.toast')).toBeNull();

    act(() => toasts.placeIn(place));
    expect(place.querySelector('.toast')?.textContent).toContain('Changed “Order chairs”.');
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);

    act(() => toasts.placeIn(null));
    expect(place.querySelector('.toast')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    place.remove();
  });

  it('records a warning in Activity once, however often it is placed again', () => {
    const toasts = createToasts();
    const record = vi.fn();
    const place = document.createElement('div');
    document.body.append(place);
    render(<ToastHost toasts={toasts} activity={{ record }} />);
    act(() => void toasts.show({ message: 'It changed since.', tone: 'warning' }));
    act(() => toasts.placeIn(place));
    act(() => toasts.placeIn(null));
    expect(record).toHaveBeenCalledTimes(1);
    place.remove();
  });

  it('keeps the latest place it is given, and null puts them back in the window', () => {
    const toasts = createToasts();
    const first = document.createElement('div');
    const second = document.createElement('div');
    toasts.placeIn(first);
    toasts.placeIn(second);
    toasts.placeIn(null);
    expect(toasts.store.getState().place).toBeNull();
  });
});
