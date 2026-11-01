import { useEffect, useState } from 'react';
import { readEventTime } from '@dfai/domain';
import { localNow } from '../today.ts';

/** How often the clock's now line moves: once a minute is all it can show. */
const TICK_MS = 60_000;

/** Minutes after midnight where the person is, as the calendar's clock reads a time. */
function minutesNow(): number | null {
  return readEventTime(localNow())?.minutes ?? null;
}

/** Minutes after midnight now, kept current, for the line across today on a calendar's clock. */
export function useMinuteNow(): number | null {
  const [now, setNow] = useState(minutesNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(minutesNow()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
