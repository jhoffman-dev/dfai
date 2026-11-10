import {
  ACTIVITY_KINDS,
  type ActivityKind,
  type ActivityLevel,
  type ActivityLevelFilter,
} from '@dfai/domain';
import { useRef, type Ref } from 'react';
import {
  EventDetailsButton,
  EventDetailsHost,
  LEVEL_LABELS,
  type EventDetailsView,
} from '../details/index.ts';
import { Icon } from '../icon.tsx';
import { PageBar, type PageHistory } from '../page-bar.tsx';
import { HiddenTitle } from '../page-head.tsx';
import { SegmentedControl, type SegmentedOption } from '../segmented-control.tsx';

/** One line of the log as the page shows it. */
export interface ActivityRowView {
  readonly id: string;
  /** "Today 14:03", as the person reads it. */
  readonly time: string;
  /** The same moment for `<time>`, in ISO form. */
  readonly dateTime: string;
  readonly level: ActivityLevel;
  readonly kind: ActivityKind;
  readonly message: string;
  /** What the line is about, named for its link; null when it links nowhere. */
  readonly subject: string | null;
  /** What the line opens to (#815); absent for a line that opens to nothing. */
  readonly details?: EventDetailsView;
}

/** A meeting with its lines under it (#192): its import's, its linking's, and the rules that heard it. */
export interface ActivityMeetingView {
  readonly group: 'meeting';
  /** The id of the line whose link opens the meeting. */
  readonly id: string;
  readonly title: string;
  /** Newest first. */
  readonly rows: readonly ActivityRowView[];
}

/** A place on the page: a line, or a meeting's lines together. */
export type ActivityEntryView = ActivityRowView | ActivityMeetingView;

export interface ActivityPageProps {
  /** The lines the filters let through, newest first; null while the log is being read. */
  readonly rows: readonly ActivityEntryView[] | null;
  /** How many lines the log holds, whatever the filters. */
  readonly total: number;
  readonly error: string | null;
  readonly level: ActivityLevelFilter;
  /** The kinds chosen; none chosen shows every kind. */
  readonly kinds: readonly ActivityKind[];
  readonly text: string;
  readonly onLevel: (level: ActivityLevelFilter) => void;
  readonly onToggleKind: (kind: ActivityKind) => void;
  readonly onText: (text: string) => void;
  /** Opens what a line is about, by the line's id. */
  readonly onOpenSubject: (id: string) => void;
  /** Puts a line's details on the clipboard; rejects when the clipboard refuses. */
  readonly onCopy: (text: string) => Promise<void>;
  readonly onShowSidebar?: () => void;
  readonly history?: PageHistory;
}

const LEVELS: readonly SegmentedOption<ActivityLevelFilter>[] = [
  { value: 'all', label: 'Everything' },
  { value: 'warnings', label: 'Warnings and errors' },
  { value: 'errors', label: 'Errors only' },
];

/** What each kind's filter, and each line's kind, is called. */
export const ACTIVITY_KIND_LABELS: Readonly<Record<ActivityKind, string>> = {
  automation: 'Automations',
  source: 'Sources',
  meeting: 'Meetings',
  api: 'API & MCP',
  chat: 'Claude',
  index: 'Index',
  save: 'Saves',
  export: 'Exports',
  sync: 'Sync',
  app: 'App',
};

/**
 * The Activity page (U-28): what DFAI has been doing and what went wrong,
 * one line each, newest first — narrowed by level, by kind and by words, and
 * each line a click from the note, rule or source it is about.
 */
export function ActivityPage(props: ActivityPageProps) {
  const counted = describe(props.total);
  const page = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  return (
    <>
      <PageBar
        crumb={{ icon: 'activity', parent: 'Activity' }}
        name="All activity"
        {...(counted !== null && { count: counted })}
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="panel__body">
        <article
          ref={page}
          className="page page--wide activity"
          aria-label="Activity"
          tabIndex={-1}
        >
          <HiddenTitle>All activity</HiddenTitle>
          <Filters {...props} />
          {/* Above the lines: a line's details stay open as the log regroups and trims under them
              (#815). Closed with their line gone, they hand the focus to the list, or to the
              page where no line is left to list. */}
          <EventDetailsHost landmark={() => list.current ?? page.current}>
            <Lines {...props} list={list} />
          </EventDetailsHost>
        </article>
      </div>
    </>
  );
}

/** How many lines the log holds and how long it keeps them, beside the page's name; nothing while it is empty. */
function describe(total: number): string | null {
  if (total === 0) return null;
  return `${total} ${total === 1 ? 'line' : 'lines'} · kept 30 days`;
}

function Filters({ level, kinds, text, onLevel, onToggleKind, onText }: ActivityPageProps) {
  return (
    <div className="activity__filters">
      <SegmentedControl label="Show" options={LEVELS} value={level} onChange={onLevel} />
      <div className="activity__kinds" role="group" aria-label="Kinds">
        {ACTIVITY_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="btn btn--ghost btn--sm activity__kind"
            aria-pressed={kinds.includes(kind)}
            onClick={() => onToggleKind(kind)}
          >
            {ACTIVITY_KIND_LABELS[kind]}
          </button>
        ))}
      </div>
      <label className="page-search activity__search">
        <Icon name="search" size={14} />
        <input
          type="search"
          className="page-search__input"
          aria-label="Search activity"
          placeholder="Search the activity…"
          value={text}
          onChange={(event) => onText(event.target.value)}
        />
      </label>
    </div>
  );
}

function Lines({
  rows,
  total,
  error,
  onOpenSubject,
  onCopy,
  list,
}: ActivityPageProps & { list: Ref<HTMLOListElement> }) {
  const does: LineActions = { onOpenSubject, onCopy };
  if (error !== null) {
    return (
      <p className="table__error" role="alert">
        {error}
      </p>
    );
  }
  if (rows === null) return <p className="table__empty">Reading the log…</p>;
  if (total === 0) {
    return (
      <p className="activity__empty">
        Nothing yet. Automation runs, source refreshes, writes from other tools, Claude’s accepted
        edits and anything that goes wrong will show here.
      </p>
    );
  }
  if (rows.length === 0) return <p className="activity__empty">No lines match.</p>;
  return (
    <ol ref={list} className="page-list activity__list" aria-label="Activity lines" tabIndex={-1}>
      {rows.map((entry) =>
        'group' in entry ? (
          <Meeting key={`meeting:${entry.id}`} meeting={entry} does={does} />
        ) : (
          <Line key={entry.id} row={entry} does={does} />
        ),
      )}
    </ol>
  );
}

/** What a line can do: open what it is about, and copy its details. */
type LineActions = Pick<ActivityPageProps, 'onOpenSubject' | 'onCopy'>;

function Meeting({ meeting, does }: { meeting: ActivityMeetingView; does: LineActions }) {
  return (
    <li className="activity-group" aria-label={`Meeting ${meeting.title}`}>
      <div className="activity-group__head">
        <Icon name="calendar" size={14} />
        <span className="activity-group__title">{meeting.title}</span>
        <button
          type="button"
          className="btn btn--ghost btn--sm activity-line__open"
          title={`Open ${meeting.title}`}
          onClick={() => does.onOpenSubject(meeting.id)}
        >
          <span className="activity-line__open-text">Open {meeting.title}</span>
        </button>
      </div>
      <ol className="page-list activity-group__lines" aria-label={`Lines about ${meeting.title}`}>
        {meeting.rows.map((row) => (
          <Line key={row.id} row={row} does={does} />
        ))}
      </ol>
    </li>
  );
}

function Line({ row, does }: { row: ActivityRowView; does: LineActions }) {
  return (
    <li key={row.id} className={`page-list__row activity-line activity-line--${row.level}`}>
      <time className="page-list__meta activity-line__time" dateTime={row.dateTime}>
        {row.time}
      </time>
      <span className={`page-list__meta activity-line__level activity-line__level--${row.level}`}>
        {LEVEL_LABELS[row.level]}
      </span>
      <span className="page-list__meta activity-line__kind">{ACTIVITY_KIND_LABELS[row.kind]}</span>
      <Message row={row} does={does} />
      {row.subject !== null && (
        <button
          type="button"
          className="btn btn--ghost btn--sm activity-line__open"
          title={`Open ${row.subject}`}
          onClick={() => does.onOpenSubject(row.id)}
        >
          <span className="activity-line__open-text">Open {row.subject}</span>
        </button>
      )}
    </li>
  );
}

/**
 * A line's words. One line per row, so a long message is cut short: its title
 * holds the whole of it, and a line with details opens to them (#815).
 */
function Message({ row, does }: { row: ActivityRowView; does: LineActions }) {
  if (row.details === undefined) {
    return (
      <span className="activity-line__message" title={row.message}>
        {row.message}
      </span>
    );
  }
  return (
    <EventDetailsButton
      details={row.details}
      id={row.id}
      className="activity-line__message"
      title={row.message}
      onCopy={does.onCopy}
      {...(row.subject !== null && { onOpenSubject: () => does.onOpenSubject(row.id) })}
    >
      {row.message}
    </EventDetailsButton>
  );
}
