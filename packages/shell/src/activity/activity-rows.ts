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
 * id is its own (`lineIds`), so it keeps it as newer ones arrive and the
 * oldest go.
 */
export function activityRows(events: readonly ActivityEvent[], today: string): ActivityRowView[] {
  const ids = lineIds(events);
  return events.map((event, index) => rowOf(event, ids[index] ?? '', today));
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
  const ids = lineIds(events);
  return groupActivity(events).flatMap((item): ActivityEntryView | ActivityEntryView[] => {
    const lines = (item.kind === 'line' ? [item.line] : item.lines).flatMap((line) => {
      const event = events[line];
      return event === undefined ? [] : [{ event, line }];
    });
    const rows = lines.map(({ event, line }) => rowOf(event, ids[line] ?? '', today));
    if (item.kind === 'line') return rows[0] ?? [];
    const opens = lines.find(({ event }) => event.subject?.path === item.meeting) ?? lines[0];
    return {
      group: 'meeting' as const,
      id: ids[opens?.line ?? 0] ?? '',
      title: noteTitle(item.meeting),
      rows,
    };
  });
}

/**
 * Each line's id, in the order given: when it happened and what it said, so
 * the line keeps it while the log grows at one end and is trimmed at the
 * other (#815) — a place in the list would pass to another line. Lines alike
 * in both are told apart by a count from the oldest of them.
 */
function lineIds(events: readonly ActivityEvent[]): string[] {
  const alike = new Map<string, number>();
  const ids = new Array<string>(events.length);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const said = `${event.at}-${wordsMark(`${event.level} ${event.kind} ${event.message}`)}`;
    const before = alike.get(said) ?? 0;
    alike.set(said, before + 1);
    ids[index] = before === 0 ? said : `${said}-${before}`;
  }
  return ids;
}

/** A short mark of some words (FNV-1a), to tell lines of one moment apart: not a secret, not a checksum. */
function wordsMark(words: string): string {
  let mark = 0x811c9dc5;
  for (let at = 0; at < words.length; at += 1) {
    mark = Math.imul(mark ^ words.charCodeAt(at), 0x01000193);
  }
  return (mark >>> 0).toString(36);
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
  const index = lineIds(events).indexOf(id);
  return events[index]?.subject ?? null;
}
