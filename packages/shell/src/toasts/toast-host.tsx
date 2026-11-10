import { memo, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { noticeReport } from '@dfai/domain';
import type { ActivityLog, Clock } from '@dfai/application';
import { EventDetailsHost, ToastStack, type ToastShown } from '@dfai/ui';
import { noticeDetails } from '../activity/event-details.ts';
import { browserClipboard, type ClipboardWriter } from '../settings/clipboard.ts';
import { localClock } from '../today.ts';
import type { Toasts, ToastsState } from './toasts.ts';

/**
 * The window's toasts, drawn over the content and subscribed to their own
 * store alone (#320). A warning or an error is said in Activity too, once,
 * as it is shown — from the store itself, not from what was drawn, so one
 * pushed out by newer toasts before the next draw is still kept — and one
 * missed while it showed can be found later; a change made is not: the file
 * is its record. A warning or an error opens, from its words, to the
 * details of its own words (#815), which stay open though the toast goes —
 * pushed out by newer ones, replaced in its slot, let go with its vault: the
 * popup is held here, above the queue. Another vault opening lets every toast go, since each
 * one's Undo belongs to the vault it was made in. `children` are toasts
 * still drawn by their own hooks, kept in the same column.
 *
 * Kept from the window's draws: the window is drawn often as a vault opens,
 * and the toasts change only with their own store.
 */
export const ToastHost = memo(function ToastHost({
  toasts,
  activity,
  vault,
  clock = localClock,
  clipboard = browserClipboard,
  children,
}: {
  toasts: Toasts;
  activity: Pick<ActivityLog, 'record'>;
  /** The vault open now; toasts are let go when it changes. */
  vault?: string | null;
  /** Names the day a toast's details are dated against. */
  clock?: Pick<Clock, 'today'>;
  /** Where a toast's details are copied to. */
  clipboard?: ClipboardWriter;
  children?: ReactNode;
}) {
  const queue = useStore(toasts.store, (state) => state.toasts);
  const place = useStore(toasts.store, (state) => state.place);
  useWarningsRecorded(toasts, activity);
  useEffect(() => toasts.openVault(vault ?? null), [toasts, vault]);
  // Dated on every draw: a toast left up past midnight is yesterday's.
  const shown = withDetails(queue, clock.today());
  const stack = (
    <ToastStack toasts={shown} onDismiss={toasts.dismiss} onCopy={(text) => clipboard.write(text)}>
      {children}
    </ToastStack>
  );
  // In the peek's place while it is up: inside its focus trap, so Tab reaches an Undo (#468).
  // The details are held outside that place, so they stay as the peek comes and goes.
  return <EventDetailsHost>{place === null ? stack : createPortal(stack, place)}</EventDetailsHost>;
});

/** The toasts, each warning and error with the details its words open to. */
function withDetails(queue: ToastsState['toasts'], today: string): ToastShown[] {
  return queue.map((toast) =>
    toast.tone === 'change'
      ? toast
      : { ...toast, details: noticeDetails({ ...toast, level: toast.tone }, today) },
  );
}

/** Records each warning and error toast in Activity once, as the store first holds it. */
function useWarningsRecorded(toasts: Toasts, activity: Pick<ActivityLog, 'record'>): void {
  const recorded = useRef(0);
  useEffect(() => {
    const record = ({ toasts: queue }: ToastsState) => {
      for (const toast of queue) {
        if (toast.id <= recorded.current) continue;
        recorded.current = toast.id;
        if (toast.tone !== 'change') activity.record(noticeReport(toast.message, toast.tone));
      }
    };
    record(toasts.store.getState());
    return toasts.store.subscribe(record);
  }, [toasts, activity]);
}
