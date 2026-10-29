import { useEffect, useState } from 'react';
import type { Clock } from '@dfai/application';

/** How often an open page asks the clock whether the day has turned. */
const DAY_CHECK_MS = 60_000;

/**
 * The clock's day, asked again each minute and whenever the window is looked
 * at again, while the page is open: a page left open overnight — the Mac
 * asleep, timers and all — turns to the new day when it is next seen.
 */
export function useDayOf(clock: Pick<Clock, 'today'>, open: boolean): string {
  const [day, setDay] = useState(() => clock.today());
  useEffect(() => {
    if (!open) return;
    const ask = () => setDay(clock.today());
    ask();
    const timer = setInterval(ask, DAY_CHECK_MS);
    window.addEventListener('focus', ask);
    document.addEventListener('visibilitychange', ask);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', ask);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [clock, open]);
  return day;
}
