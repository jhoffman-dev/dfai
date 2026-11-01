import { memo, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { noticeReport } from '@dfai/domain';
import type { ActivityLog } from '@dfai/application';
import { ToastStack } from '@dfai/ui';
import type { Toasts, ToastsState } from './toasts.ts';

/**
 * The window's toasts, drawn over the content and subscribed to their own
 * store alone (#320). A warning or an error is said in Activity too, once,
 * as it is shown — from the store itself, not from what was drawn, so one
 * pushed out by newer toasts before the next draw is still kept — and one
 * missed while it showed can be found later; a change made is not: the file
 * is its record. Another vault opening lets every toast go, since each
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
  children,
}: {
  toasts: Toasts;
  activity: Pick<ActivityLog, 'record'>;
  /** The vault open now; toasts are let go when it changes. */
  vault?: string | null;
  children?: ReactNode;
}) {
  const queue = useStore(toasts.store, (state) => state.toasts);
  const place = useStore(toasts.store, (state) => state.place);
  useWarningsRecorded(toasts, activity);
  useEffect(() => toasts.openVault(vault ?? null), [toasts, vault]);
  const stack = (
    <ToastStack toasts={queue} onDismiss={toasts.dismiss}>
      {children}
    </ToastStack>
  );
  // In the peek's place while it is up: inside its focus trap, so Tab reaches an Undo (#468).
  return place === null ? stack : createPortal(stack, place);
});

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
