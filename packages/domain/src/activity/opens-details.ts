import type { ActivityLevel } from './activity-event.ts';

/**
 * Whether a line of this level opens to its details (#815): one that tells of
 * something wrong. A line of plain news says all it has in its one line.
 */
export function opensDetails(level: ActivityLevel): boolean {
  return level !== 'info';
}
