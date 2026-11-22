import { useState } from 'react';
import {
  AGENDA_DAYS,
  buildAgenda,
  formatPropertyDate,
  relativeDay,
  timeLabel,
  type AgendaDues,
  type CalendarEvent,
  type PropertyKind,
} from '@dfai/domain';
import { DoneCheckbox, doneClass, type DoneTicks } from './done-checkbox.tsx';
import { NoteFields } from './note-fields.tsx';

const NEVER_DONE = () => false;

/**
 * The calendar as a list: what is overdue at the top, then each day from the
 * one shown with its notes in the order they happen. "Load more" lists
 * another thirty days.
 */
export function CalendarAgenda({
  events,
  anchor,
  today,
  fields,
  kinds,
  ticks,
  onOpenNote,
  dues,
}: {
  events: readonly CalendarEvent[];
  anchor: string;
  today: string;
  /** Given for a calendar of tasks by their due: Overdue is then said as Today says it. */
  dues?: AgendaDues | undefined;
  /** The properties each row shows as chips, the view's date left out. */
  fields: readonly string[];
  kinds: Readonly<Record<string, PropertyKind>>;
  ticks: DoneTicks | undefined;
  onOpenNote: (path: string) => void;
}) {
  const [loaded, setLoaded] = useState({ anchor, days: AGENDA_DAYS });
  // Paging to another day starts the list again at thirty days.
  const days = loaded.anchor === anchor ? loaded.days : AGENDA_DAYS;
  const agenda = buildAgenda({
    events,
    from: anchor,
    days,
    today,
    isDone: ticks?.isDone ?? NEVER_DONE,
    dues,
  });
  const row = { fields, kinds, ticks, onOpenNote };

  return (
    <div className="agenda">
      {agenda.overdue.length > 0 && (
        <section className="agenda__day agenda__day--overdue" aria-label="Overdue">
          <h3 className="agenda__heading">
            Overdue <span className="agenda__count">{agenda.overdue.length}</span>
          </h3>
          <ul className="agenda__list">
            {agenda.overdue.map((event) => (
              <AgendaRow key={event.path} event={event} date={event.start.date} dated {...row} />
            ))}
          </ul>
        </section>
      )}
      {agenda.days.map((day) => {
        const near = relativeDay(day.date, today);
        const label = formatPropertyDate(day.date) ?? day.date;
        return (
          <section
            key={day.date}
            className={day.date === today ? 'agenda__day agenda__day--today' : 'agenda__day'}
            aria-label={near === null ? label : `${near}, ${label}`}
          >
            <h3 className="agenda__heading">
              {near !== null && <span className="agenda__near">{near}</span>}
              {label}
            </h3>
            {day.events.length === 0 ? (
              <p className="agenda__empty">Nothing scheduled.</p>
            ) : (
              <ul className="agenda__list">
                {day.events.map((event) => (
                  <AgendaRow key={event.path} event={event} date={day.date} {...row} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <button
        type="button"
        className="agenda__more"
        onClick={() => setLoaded({ anchor, days: days + AGENDA_DAYS })}
      >
        Load more
      </button>
    </div>
  );
}

function AgendaRow({
  event,
  date,
  dated = false,
  fields,
  kinds,
  ticks,
  onOpenNote,
}: {
  event: CalendarEvent;
  date: string;
  /** Overdue rows say which day they were on, since no heading does. */
  dated?: boolean;
  fields: readonly string[];
  kinds: Readonly<Record<string, PropertyKind>>;
  ticks: DoneTicks | undefined;
  onOpenNote: (path: string) => void;
}) {
  const when = timeLabel(event, date);
  return (
    <li className={doneClass('agenda__row', ticks, event.values)} data-path={event.path}>
      {ticks !== undefined && (
        <DoneCheckbox path={event.path} title={event.title} values={event.values} ticks={ticks} />
      )}
      <span className="agenda__time">
        {dated
          ? `${formatPropertyDate(date) ?? date}${when === 'All day' ? '' : `, ${when}`}`
          : when}
      </span>
      <button type="button" className="agenda__title" onClick={() => onOpenNote(event.path)}>
        {event.title}
      </button>
      <NoteFields row={event} fields={fields} kinds={kinds} className="agenda__fields" />
    </li>
  );
}
