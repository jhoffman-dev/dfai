import { useEffect, useState } from 'react';
import { wallTimeOf } from '@dfai/domain';
import type { Clock } from '@dfai/application';

/** How often an open page asks the clock whether a timed due has passed: as often as the day. */
const TURN_CHECK_MS = 60_000;

/**
 * How many times a timed due on the page has passed while it was open (#928):
 * asked each minute, and whenever the window is looked at again, once the
 * wall clock is past `turn` (`nextDueTurn`) — so a read keyed on it moves the
 * task to Overdue. Nothing is asked while there is no turn ahead, and a turn
 * is counted once: the read it starts hands the next one.
 */
export function useDueTurns(
  clock: Partial<Pick<Clock, 'localNow'>>,
  open: boolean,
  turn: string | null,
): number {
  const [turns, setTurns] = useState(0);
  useEffect(() => {
    const localNow = clock.localNow;
    if (!open || turn === null || localNow === undefined) return;
    let counted = false;
    const ask = () => {
      const time = wallTimeOf(localNow());
      if (counted || time === null || time <= turn) return;
      counted = true;
      setTurns((was) => was + 1);
    };
    ask();
    const timer = setInterval(ask, TURN_CHECK_MS);
    window.addEventListener('focus', ask);
    document.addEventListener('visibilitychange', ask);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', ask);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [clock, open, turn]);
  return turns;
}
