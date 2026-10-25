import type { VaultPath } from '@dfai/domain';

/** A meeting on the Today page, as it is drawn. */
export interface TodayMeetingRow {
  readonly path: VaultPath;
  readonly title: string;
  /** `09:00–09:30`, or the start alone. */
  readonly time: string;
  /** Who it is with, by the names of their notes. */
  readonly people: readonly string[];
  /** Not answered yet, or answered maybe. */
  readonly unanswered: boolean;
}

/**
 * Today's meetings (ADR-0046), above the day's tasks: each opens its event
 * note, where the person writes their prep. Nothing is drawn on a day with
 * none, nor where meetings are not read.
 */
export function TodayMeetings({
  meetings,
  onOpen,
}: {
  meetings: readonly TodayMeetingRow[];
  onOpen: (path: VaultPath) => void;
}) {
  if (meetings.length === 0) return null;
  return (
    <section className="review__section today__meetings" aria-label="Meetings">
      <h2 className="review__heading">Meetings</h2>
      <ul className="today__meeting-list">
        {meetings.map((meeting) => (
          <li key={meeting.path} className="today__meeting">
            <button
              type="button"
              className="today__meeting-open"
              onClick={() => onOpen(meeting.path)}
            >
              <span className="today__meeting-time">{meeting.time}</span>
              <span className="today__meeting-title">{meeting.title}</span>
            </button>
            {meeting.people.length > 0 && (
              <span className="today__meeting-people">with {meeting.people.join(', ')}</span>
            )}
            {meeting.unanswered && <span className="today__meeting-note">not answered</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
