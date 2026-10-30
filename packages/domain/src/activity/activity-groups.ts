import type { VaultPath } from '../vault/vault-path.ts';
import type { ActivityEvent } from './activity-event.ts';

/**
 * One place on the Activity page: a line on its own, or a meeting with its
 * lines under it (#192). Lines are named by their place in the list given.
 */
export type ActivityItem =
  | { readonly kind: 'line'; readonly line: number }
  | { readonly kind: 'meeting'; readonly meeting: VaultPath; readonly lines: readonly number[] };

/**
 * The lines, in the order given (newest first), with each meeting's lines
 * gathered under it — its import's and its linking's (lines of kind
 * `meeting` about it), and the runs of rules that heard it and nothing else.
 * A run that heard several notes is about none of them alone, and stays a
 * line of its own. A meeting stands where its newest line would, and its
 * lines keep their order. A meeting with one line is that line: there is
 * nothing to gather.
 */
export function groupActivity(events: readonly ActivityEvent[]): ActivityItem[] {
  const meetings = new Set(events.flatMap((event) => meetingLineOf(event) ?? []));
  const lines = new Map<VaultPath, number[]>();
  events.forEach((event, index) => {
    const meeting = meetingOf(event, meetings);
    if (meeting !== null) lines.set(meeting, [...(lines.get(meeting) ?? []), index]);
  });
  const placed = new Set<VaultPath>();
  return events.flatMap((event, index): ActivityItem[] => {
    const meeting = meetingOf(event, meetings);
    const under = meeting === null ? [] : (lines.get(meeting) ?? []);
    if (meeting === null || under.length < 2) return [{ kind: 'line', line: index }];
    if (placed.has(meeting)) return [];
    placed.add(meeting);
    return [{ kind: 'meeting', meeting, lines: under }];
  });
}

/** The meeting a line goes under, among those with lines of their own; null for none. */
function meetingOf(event: ActivityEvent, meetings: ReadonlySet<VaultPath>): VaultPath | null {
  const own = meetingLineOf(event);
  if (own !== null) return own;
  const notes = event.notes ?? [];
  const only = notes.length === 1 ? notes[0] : undefined;
  return only !== undefined && meetings.has(only) ? only : null;
}

/** The meeting a line of kind `meeting` is about; null for any other line. */
function meetingLineOf(event: ActivityEvent): VaultPath | null {
  return event.kind === 'meeting' && event.subject?.kind === 'note' ? event.subject.path : null;
}
