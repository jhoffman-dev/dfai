import type { ReactNode } from 'react';

/**
 * A due's time of day (#928), muted beside its day: " at 15:30". Shown only
 * where a due names one. A function its row calls, not a component: each
 * component a row holds is a render the work budgets count.
 */
export function dueTimeLabel(time: string): ReactNode {
  return <span className="due-time"> at {time}</span>;
}
