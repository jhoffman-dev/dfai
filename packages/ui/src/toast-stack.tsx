import type { ReactNode } from 'react';
import type { EventDetailsView } from './details/index.ts';
import { Toast, type ToastTone } from './toast.tsx';

/** One toast in the window's queue (#320), as the store that holds them hands it over. */
export interface ToastShown {
  /** Each showing's own, so the same words said twice are two toasts with two times. */
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
  /** Takes the change back; absent when there is nothing to take back. */
  readonly onUndo?: () => void;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** What a warning or an error opens to from its words (#815). */
  readonly details?: EventDetailsView;
}

/**
 * The window's toasts, top to bottom oldest first, in one place over the
 * content (#320). Each keeps its own five seconds and its own hold while the
 * pointer or the focus is on it; none takes the focus. `children` are the
 * toasts something else still draws itself, kept in the same column so two
 * never sit on one another.
 */
export function ToastStack({
  toasts,
  onDismiss,
  onCopy,
  children,
}: {
  toasts: readonly ToastShown[];
  onDismiss: (id: number) => void;
  /** Puts a toast's details on the clipboard; without it no toast opens to them. */
  onCopy?: (text: string) => Promise<void>;
  children?: ReactNode;
}) {
  const others = children !== undefined && children !== null && children !== false;
  if (toasts.length === 0 && !others) return null;
  return (
    <div className="toast-stack">
      {children}
      {toasts.map(({ id, message, tone, onUndo, action, details }) => (
        <Toast
          key={id}
          message={message}
          tone={tone}
          {...(onUndo !== undefined && { onUndo })}
          {...(action !== undefined && { action })}
          {...(details !== undefined && onCopy !== undefined && { details, onCopy })}
          onDismiss={() => onDismiss(id)}
        />
      ))}
    </div>
  );
}
