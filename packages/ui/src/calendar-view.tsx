import { useMemo, useRef } from 'react';
import {
  calendarEvents,
  clockLabel,
  dueEventTime,
  movedDue,
  movedEvent,
  rangeDays,
  resizedEnd,
  slotValue,
  type BoardRow,
  type CalendarEvent,
  type PropertyKind,
} from '@dfai/domain';
import { CalendarAgenda } from './calendar-agenda.tsx';
import type { CalendarGestures, ClockGesture } from './calendar-gestures.ts';
import { answerCalendarKey } from './calendar-keys.ts';
import { CalendarMonthGrid } from './calendar-month-grid.tsx';
import type { CalendarNavigation } from './calendar-nav.tsx';
import { CalendarTimeGrid } from './calendar-time-grid.tsx';
import type { DoneTicks } from './done-checkbox.tsx';
import type { Planner } from './schedule-tray.tsx';

/** What a move or a resize writes: the date, and the end when that changes too. */
export interface CalendarWrite {
  readonly path: string;
  readonly start: string;
  /** Null leaves the end property as it is. */
  readonly end: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The gestures, with what each writes worked out by the domain's rules. */
function useGestures({
  dateKey,
  endKey,
  onOpenNote,
  onReschedule,
  onCreate,
  holdingRef,
  taskDues,
}: {
  dateKey: string;
  endKey: string | null;
  /** A calendar of tasks by due: a move is the due rules' (`movedDue`), as its placing is. */
  taskDues: boolean;
  onOpenNote: (path: string) => void;
  onReschedule: (write: CalendarWrite) => void;
  onCreate: ((args: { value: string; name: string }) => void) | undefined;
  /** Whether a note is held, which the calendar's keys must leave alone. */
  holdingRef: { current: boolean };
}): CalendarGestures {
  return useMemo(() => {
    const valuesOf = (event: CalendarEvent) => ({
      start: text(event.values[dateKey]) ?? '',
      end: endKey === null ? null : text(event.values[endKey]),
    });
    const move = taskDues ? movedDue : movedEvent;
    const moved = (event: CalendarEvent, by: ClockGesture) => move({ ...valuesOf(event), ...by });
    const resized = (event: CalendarEvent, minutes: number) =>
      resizedEnd({ event, ...valuesOf(event), minutes });
    return {
      open: onOpenNote,
      move: (event, by) => onReschedule({ path: event.path, ...moved(event, by) }),
      canResize: endKey !== null,
      resize: (event, minutes) => {
        const end = resized(event, minutes);
        if (end !== null) onReschedule({ path: event.path, start: valuesOf(event).start, end });
      },
      landing: (event, { resizing, ...by }) =>
        resizing ? (resized(event, by.minutes) ?? '') : moved(event, by).start,
      canCreate: onCreate !== undefined,
      create: ({ date, minutes, name }) => onCreate?.({ value: slotValue(date, minutes), name }),
      onHold: (held) => {
        holdingRef.current = held;
      },
    };
  }, [dateKey, endKey, onOpenNote, onReschedule, onCreate, holdingRef, taskDues]);
}

/**
 * A view drawn as a calendar: a month, a week, three days, a day, or an
 * agenda, as the toolbar's range says (`CalendarNav`).
 *
 * Notes are placed by their date property; one with no date is not on the
 * calendar at all, which is the honest thing to show — it is not scheduled —
 * and is counted instead. A date with a time puts the note on a day's clock.
 *
 * With the calendar focused, M, W, 3, D and A choose the range, T goes to
 * today, and Left and Right (or [ and ]) page.
 *
 * A calendar of blocks plans the day (P31-02): its week, three days or day
 * has the next actions beside the clock, to drag into time.
 */
export function CalendarView({
  rows,
  dateKey,
  endKey = null,
  calendar,
  today,
  now = null,
  fields = [],
  kinds = {},
  ticks,
  onOpenNote,
  onReschedule,
  onCreate,
  planner = null,
  taskDues = false,
}: {
  rows: readonly BoardRow[];
  dateKey: string;
  /** Where each note's end is read from, when the view has one; see `calendarEndKey`. */
  endKey?: string | null;
  calendar: CalendarNavigation;
  /** Today, passed in rather than read here, so the view can be tested. */
  today: string;
  /** Minutes after midnight now, for the line across today on the clock. */
  now?: number | null;
  /** The view's columns, shown as chips in the agenda. */
  fields?: readonly string[];
  kinds?: Readonly<Record<string, PropertyKind>>;
  ticks?: DoneTicks;
  onOpenNote: (path: string) => void;
  onReschedule: (write: CalendarWrite) => void;
  /** Adds a note of the view's type on a day or at a time; without it, nothing is added. */
  onCreate?: (args: { value: string; name: string }) => void;
  /** The tray of tasks to plan into a calendar of blocks; null for any other calendar. */
  planner?: Planner | null;
  /** Whether its notes are tasks by their due (`readsTaskDue`), whose Overdue Today's rule says. */
  taskDues?: boolean;
}) {
  const holdingRef = useRef(false);
  const { events, unscheduled } = useMemo(
    () =>
      calendarEvents({
        rows,
        dateKey,
        endKey,
        ...(taskDues && { readStart: dueEventTime }),
      }),
    [rows, dateKey, endKey, taskDues],
  );
  const gestures = useGestures({
    dateKey,
    endKey,
    onOpenNote,
    onReschedule,
    onCreate,
    holdingRef,
    taskDues,
  });
  const chips = useMemo(() => fields.filter((key) => key !== dateKey), [fields, dateKey]);
  const { range, anchor } = calendar;

  return (
    <div
      className={`calendar calendar--${range}`}
      role="region"
      aria-label="Calendar"
      tabIndex={-1}
      onKeyDown={(event) => answerCalendarKey({ event, calendar, holding: holdingRef.current })}
    >
      {unscheduled > 0 && (
        <p className="calendar__unscheduled">
          {unscheduled} with no {dateKey}
        </p>
      )}
      {range === 'month' && (
        <CalendarMonthGrid events={events} anchor={anchor} today={today} gestures={gestures} />
      )}
      {range === 'agenda' && (
        <CalendarAgenda
          events={events}
          anchor={anchor}
          today={today}
          fields={chips}
          kinds={kinds}
          ticks={ticks}
          onOpenNote={onOpenNote}
          {...(taskDues && { dues: { time: now === null ? null : clockLabel(now) } })}
        />
      )}
      {range !== 'month' && range !== 'agenda' && (
        <CalendarTimeGrid
          range={range}
          days={rangeDays({ range, anchor })}
          events={events}
          today={today}
          now={now}
          gestures={gestures}
          planner={planner}
        />
      )}
    </div>
  );
}
