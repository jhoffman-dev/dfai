import { noteTitle, type ActivityEvent, type ActivityLevel } from '@dfai/domain';
import { LEVEL_LABELS, type EventDetailsView } from '@dfai/ui';
import { localIso, shownTime } from './shown-time.ts';

/**
 * A line of the log as its popup shows it (#815): everything the event
 * carries, laid out to read — nothing decided here, only named and dated
 * as the page names and dates a line.
 */
export function eventDetails(event: ActivityEvent, today: string): EventDetailsView {
  const view = {
    level: event.level,
    time: shownTime(event.at, today),
    dateTime: localIso(event.at),
    message: event.message,
    subject: event.subject === null ? null : noteTitle(event.subject.path),
    details: [...said(event), ...alsoAbout(event)],
  };
  return { ...view, text: detailsText(view, event.subject?.path ?? null) };
}

/**
 * What a notice or a toast opens to: its own words, whole, as it shows them
 * — not the line Activity keeps of it, which is cut to a line's length and
 * has its paths struck — dated when it was shown.
 */
export function noticeDetails(
  notice: { message: string; level: ActivityLevel; at: number },
  today: string,
): EventDetailsView {
  const view = {
    level: notice.level,
    time: shownTime(notice.at, today),
    dateTime: localIso(notice.at),
    message: notice.message,
    subject: null,
    details: [],
  };
  return { ...view, text: detailsText(view, null) };
}

/** What the event says beyond its line, as a fact of its own. */
function said(event: ActivityEvent): { label: string; value: string }[] {
  return event.detail === undefined ? [] : [{ label: 'Detail', value: event.detail }];
}

/** The notes a line is about besides its subject, as one more fact. */
function alsoAbout(event: ActivityEvent): { label: string; value: string }[] {
  const notes = event.notes ?? [];
  return notes.length === 0 ? [] : [{ label: 'Notes', value: notes.map(noteTitle).join(', ') }];
}

/** The details as plain text, a fact to a line, for pasting somewhere else. */
function detailsText(view: Omit<EventDetailsView, 'text'>, subjectPath: string | null): string {
  return [
    `${LEVEL_LABELS[view.level]} · ${view.time} (${view.dateTime})`,
    view.message,
    ...(view.subject === null ? [] : [`About: ${view.subject} (${subjectPath})`]),
    ...view.details.map(({ label, value }) => `${label}: ${value}`),
  ].join('\n');
}
