import {
  groupActivity,
  noteTitle,
  opensDetails,
  type ActivityEvent,
  type ActivitySubject,
} from '@dfai/domain';
import type { ActivityEntryView, ActivityRowView } from '@dfai/ui';
import { eventDetails } from './event-details.ts';
import { localIso, shownTime } from './shown-time.ts';

export { shownTime } from './shown-time.ts';

/**
 * The log's lines as the page shows them, newest first as given. Each line's
 * id counts from the oldest, so a line keeps its id as newer ones arrive.
 */
export function activityRows(events: readonly ActivityEvent[], today: string): ActivityRowView[] {
  return events.map((event, index) => rowOf(event, idOf(events, index), today));
}

/**
 * The log's lines as the page shows them, a meeting's lines under it (#192):
 * where the domain gathers them, in the order given. A meeting opens as its
 * newest line about it does.
 */
export function activityEntries(
  events: readonly ActivityEvent[],
  today: string,
): ActivityEntryView[] {
  return groupActivity(events).flatMap((item): ActivityEntryView | ActivityEntryView[] => {
    const lines = (item.kind === 'line' ? [item.line] : item.lines).flatMap((line) => {
      const event = events[line];
      return event === undefined ? [] : [{ event, line }];
    });
    const rows = lines.map(({ event, line }) => rowOf(event, idOf(events, line), today));
    if (item.kind === 'line') return rows[0] ?? [];
    const opens = lines.find(({ event }) => event.subject?.path === item.meeting) ?? lines[0];
    return {
      group: 'meeting' as const,
      id: idOf(events, opens?.line ?? 0),
      title: noteTitle(item.meeting),
      rows,
    };
  });
}

/** A line's id counts from the oldest, so it keeps it as newer ones arrive. */
function idOf(events: readonly ActivityEvent[], index: number): string {
  return String(events.length - 1 - index);
}

function rowOf(event: ActivityEvent, id: string, today: string): ActivityRowView {
  return {
    id,
    time: shownTime(event.at, today),
    dateTime: localIso(event.at),
    level: event.level,
    kind: event.kind,
    message: event.message,
    subject: event.subject === null ? null : noteTitle(event.subject.path),
    ...(opensDetails(event.level) && { details: eventDetails(event, today) }),
  };
}

/** What a row's link opens, by the row's id. */
export function subjectOf(events: readonly ActivityEvent[], id: string): ActivitySubject | null {
  const index = events.length - 1 - Number(id);
  return events[index]?.subject ?? null;
}
