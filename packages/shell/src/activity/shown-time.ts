import { addDays } from '@dfai/domain';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today, 14:03", "Yesterday, 09:12", or "27 Sep, 03:00" — the year only when it is not this one. */
export function shownTime(at: number, today: string): string {
  const date = new Date(at);
  const day = localIso(at).slice(0, 10);
  const clock = localIso(at).slice(11, 16);
  if (day === today) return `Today, ${clock}`;
  if (day === addDays(today, -1)) return `Yesterday, ${clock}`;
  const year = day.slice(0, 4) === today.slice(0, 4) ? '' : ` ${day.slice(0, 4)}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year}, ${clock}`;
}

/** The moment on this Mac's wall clock, as `YYYY-MM-DDTHH:MM:SS`. */
export function localIso(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}
