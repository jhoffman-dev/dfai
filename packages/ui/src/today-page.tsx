import { createContext, Fragment, memo, useContext, useMemo, useRef, type ReactNode } from 'react';
import {
  GTD_STATUS_LABELS,
  isGtdStatus,
  TODAY_DEFER_DAYS,
  TODAY_SECTION_LABELS,
  todayMovesFor,
  todayRowOrder,
  type TodayChoice,
  type TodayGroup,
  type TodaySection,
  type TodaySectionId,
  type TodayTask,
  type VaultPath,
} from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { Icon } from './icon.tsx';
import { heldWhile, MoveMenu, todayToggle } from './task-row-commands.tsx';
import { PageAction, PageBar, type PageHistory } from './page-bar.tsx';
import { HiddenTitle } from './page-head.tsx';
import { ROW_SCROLLER_MARK, RowScrollerContext } from './row-scroller.ts';
import { StatusPill } from './status-pill.tsx';
import { useSteadyCallback } from './steady-callback.ts';
import { Spacer } from './grouped-rows.tsx';
import { useRowFocus, type RowFocus } from './today-row-focus.ts';
import { TODAY_KEY_HINTS, todayPlaceOf, useTodayKeys } from './today-keys.ts';
import { KEYS_HOME, type UndoLast } from './row-keys.ts';
import { keyHintStrip } from './key-hints.tsx';
import { useVirtualRows } from './virtual-rows.ts';
import { delayedSpinner } from './delayed-spinner.tsx';

/** What the page did to a task, for the toast that offers to take it back. */
export type TodayAction =
  | { readonly kind: 'done' }
  | { readonly kind: 'move'; readonly status: string }
  | { readonly kind: 'defer'; readonly days: number }
  | {
      readonly kind: TodayChoice;
      /** The later day it had been chosen for, when a choice is moved from it to today. */
      readonly was?: string;
    };

/** The row an action is asked of. */
interface RowTask {
  readonly path: VaultPath;
  readonly title: string;
}

export interface TodayPageProps {
  /** Null while the index is being asked. */
  today: TodayReport | null;
  error: string | null;
  /** While a row is being acted on, so nothing is asked for twice. */
  busy: boolean;
  /** Why the last action could not be done, or null. */
  problem: string | null;
  /**
   * The rows acted on whose change the page has not read back yet: each
   * takes no further action until it has, so a second press cannot act on
   * what the row no longer is. None unless given.
   */
  settling?: ReadonlySet<VaultPath>;
  /** A saved view titled Today, which this page's sidebar row stands in for; null when the vault has none. */
  view: { readonly title: string; readonly onOpen: () => void } | null;
  onOpen: (path: VaultPath) => void;
  onOpenInbox: () => void;
  onOpenReview: () => void;
  onOpenDailyNote: () => void;
  /** Ticks a task done, as a type's view does: a repeating one rolls on. */
  onDone: (task: RowTask) => void;
  onSetStatus: (args: RowTask & { status: string }) => void;
  onDefer: (args: RowTask & { days: number }) => void;
  /** Chooses a task for today or takes it off; keeps or drops one carried over (#108). */
  onChoose: (args: RowTask & { choice: TodayChoice; was?: string }) => void;
  /**
   * Takes the last change back, as its toast's Undo does — U or ⌘Z on a row
   * (#109) — resolving to the row it took back, or null.
   */
  onUndo?: UndoLast;
  onShowSidebar?: () => void;
  history?: PageHistory;
  /** Today's meetings, drawn above the tasks (ADR-0046); nothing when left out. */
  meetings?: ReactNode;
}

/**
 * The Today page (#111): what needs you today on one screen — what was chosen
 * for today (#108) and carried over from an earlier day, what is late, due,
 * back from being put off, under way, next, and waited for — each row a tick,
 * a move, a defer or a choice from being dealt with.
 */
export function TodayPage(props: TodayPageProps) {
  // Held here, above the sections: they come and go while the index is read again,
  // and which row was acted on has to outlast that.
  const order = useMemo(
    () => (props.today === null ? [] : todayRowOrder(props.today)),
    [props.today],
  );
  const settling = props.settling ?? NONE_SETTLING;
  const home = useRef<HTMLElement>(null);
  // Not told the page is busy: a row's Done box, which holds the focus, takes
  // it while its row waits (`DoneBox`), so the next row has it at once.
  const focus = useRowFocus({
    order,
    shown: props.today,
    problem: props.problem,
    home,
    placeOf: (path) => todayPlaceOf(props.today, path),
    settling,
  });
  const actions = useRowActions(props, focus);
  const onKeyDown = useTodayKeys({
    today: props.today,
    order,
    focus,
    acts: actions,
    waits: (path) => props.busy || settling.has(path),
    undoWaits: () => props.busy || settling.size > 0,
    onUndo: props.onUndo,
  });
  const scroller = useRef<HTMLDivElement>(null);
  const counted = describe(props.today);
  // The page is named by its day, which the report brings: until then the bar
  // places nothing, as a note's does while it is read, rather than a name
  // that changes under the reader.
  const name = props.today?.today ?? null;
  return (
    <>
      <PageBar
        crumb={name === null ? null : { icon: 'today', parent: 'Today' }}
        name={name}
        {...(counted !== null && { count: counted })}
        actions={<HeadActions view={props.view} onOpenDailyNote={props.onOpenDailyNote} />}
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="panel__body panel__body--rows" ref={scroller} {...ROW_SCROLLER_MARK}>
        <RowScrollerContext.Provider value={scroller}>
          <article
            className="page page--wide review today"
            aria-label="Today"
            aria-busy={props.busy || undefined}
            onKeyDown={onKeyDown}
            ref={home}
            tabIndex={-1}
            {...KEYS_HOME}
          >
            <HiddenTitle>{name ?? 'Today'}</HiddenTitle>
            {props.problem !== null && (
              <p className="table__error" role="alert">
                {props.problem}
              </p>
            )}
            {props.meetings}
            <TodayBody
              {...props}
              focus={focus}
              actions={actions}
              place={{ wanted: focus.wanted }}
            />
          </article>
        </RowScrollerContext.Provider>
      </div>
    </>
  );
}

/**
 * What the page offers whatever its read says — while it loads, or when the
 * index cannot answer: today's note, and the vault's own Today view.
 */
function HeadActions({ view, onOpenDailyNote }: Pick<TodayPageProps, 'view' | 'onOpenDailyNote'>) {
  return (
    <>
      {view !== null && (
        <PageAction icon="table" label={`Open the “${view.title}” view`} onPress={view.onOpen} />
      )}
      <PageAction
        icon="sun"
        label="Open today’s note"
        title="Open today’s note (⇧⌘D)"
        onPress={onOpenDailyNote}
      >
        <kbd className="key today__key" aria-hidden="true">
          ⇧⌘D
        </kbd>
      </PageAction>
    </>
  );
}

/** `2026-10-13` as "Tuesday, October 13" — read as a calendar day, in no timezone. */
function weekdayName(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return at.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

/** The weekday and what waits, beside the day's date, which is the page's name. */
function describe(today: TodayReport | null): string | null {
  if (today === null) return null;
  const tasks = today.sections.reduce((sum, section) => sum + section.count, 0);
  const counted = tasks === 0 ? 'nothing needs you' : tasks === 1 ? '1 task' : `${tasks} tasks`;
  return `${weekdayName(today.today)} · ${counted}`;
}

/**
 * What the toast says of an action on a task (#320), in the words its
 * Undo takes back: "Finished “Water the beds”."
 */
export function todayActionWords({
  title,
  action,
}: {
  title: string;
  action: TodayAction;
}): string {
  if (action.kind === 'done') return `Finished “${title}”.`;
  if (action.kind === 'move') return `Moved “${title}” to ${statusLabel(action.status)}.`;
  if (action.kind === 'choose' && action.was !== undefined) {
    return `“${title}” chosen for today (was ${action.was}).`;
  }
  if (action.kind !== 'defer') return CHOICE_WORDS[action.kind](title);
  return `Deferred “${title}” by ${action.days === 1 ? '1 day' : `${action.days} days`}.`;
}

const CHOICE_WORDS: Readonly<Record<TodayChoice, (title: string) => string>> = {
  choose: (title) => `Chose “${title}” for today.`,
  unchoose: (title) => `Took “${title}” off today.`,
  keep: (title) => `Kept “${title}” for today.`,
  drop: (title) => `Dropped “${title}” from today.`,
};

const statusLabel = (status: string) => (isGtdStatus(status) ? GTD_STATUS_LABELS[status] : status);

/** Where the page's lists are placed: the row the page is about to focus. */
interface ListPlace {
  readonly wanted: VaultPath | null;
}

interface PlacedProps {
  readonly focus: RowFocus;
  readonly actions: RowActions;
  readonly place: ListPlace;
}

function TodayBody(props: TodayPageProps & PlacedProps) {
  const { today, error } = props;
  if (error !== null) {
    return (
      <p className="table__error" role="alert">
        {error}
      </p>
    );
  }
  if (today === null) return delayedSpinner('Reading the day…');
  return (
    <>
      {today.truncated && (
        <p className="review__note">
          The vault holds more tasks than the page reads at once, so some may be missing.
        </p>
      )}
      <Elsewhere {...props} today={today} />
      {keyHintStrip({ hints: TODAY_KEY_HINTS, label: 'Keys for Today' })}
      <Sections {...props} today={today} />
    </>
  );
}

/** What waits off the page: the Inbox, and the projects with nothing next. */
function Elsewhere({
  today,
  onOpenInbox,
  onOpenReview,
}: Pick<TodayPageProps, 'onOpenInbox' | 'onOpenReview'> & { today: TodayReport }) {
  const inbox = `${today.inbox.count}${today.inbox.more ? '+' : ''}`;
  const stalled = today.stalledProjects;
  return (
    <nav className="today__elsewhere" aria-label="Elsewhere">
      <button type="button" className="today__link" onClick={onOpenInbox}>
        <Icon name="inbox" size={16} />
        Inbox <span className="review__count">{inbox}</span>
        <span className="today__link-words">
          {today.inbox.count === 0 ? 'nothing to process' : 'to process'}
        </span>
      </button>
      <button type="button" className="today__link" onClick={onOpenReview}>
        <Icon name="calendar" size={16} />
        Stalled projects <span className="review__count">{stalled}</span>
        <span className="today__link-words">
          {stalled === 0 ? 'every active project has a next action' : 'in the weekly review'}
        </span>
      </button>
    </nav>
  );
}

/** What each section says when it holds nothing. */
const EMPTY: Readonly<Record<TodaySectionId, string>> = {
  chosen: 'Nothing chosen yet. Press Today on a task below to choose it.',
  carriedOver: 'Nothing carried over.',
  overdue: 'Nothing is late.',
  dueToday: 'Nothing is due today.',
  backToday: 'Nothing is back from being put off.',
  inProgress: 'Nothing is under way.',
  nextActions: 'No next actions.',
  waiting: 'Waiting on nobody.',
};

function Sections(props: TodayPageProps & PlacedProps & { today: TodayReport }) {
  const { today, busy } = props;
  const settling = props.settling ?? NONE_SETTLING;
  const { actions } = props;
  return (
    // While an action is under way, each row's action controls read it from
    // here, so that the rows themselves are not drawn again to say so (#217).
    <PageBusy.Provider value={busy}>
      <Settling.Provider value={settling}>
        <Choosing.Provider value={today.choosing}>
          {today.sections.filter(shownIn(today)).map((section) => (
            <Section
              key={section.id}
              section={section}
              place={props.place}
              settling={settling}
              actions={actions}
            />
          ))}
        </Choosing.Provider>
      </Settling.Provider>
    </PageBusy.Provider>
  );
}

/**
 * The sections drawn: Chosen for today and Carried over only where the vault
 * chooses for today (#108), and Carried over only while it holds something —
 * most mornings there is nothing to keep.
 */
const shownIn = (today: TodayReport) => (section: TodaySection) => {
  if (section.id === 'chosen') return today.choosing;
  if (section.id === 'carriedOver') return today.choosing && section.count > 0;
  return true;
};

/** Whether tasks can be chosen for today, read by each row's choice controls rather than drawn into the row. */
const Choosing = createContext(true);

/** Whether an action is under way on the page: every row's Done, Move and Defer wait for it. */
const PageBusy = createContext(false);

/**
 * The rows acted on and not read back yet, read by each row's action
 * controls: the row itself is not drawn again for it, so a tick draws no
 * row's cells but those of a row coming into the page (#247).
 */
const Settling = createContext<ReadonlySet<VaultPath>>(new Set());

/** Whether a row's actions wait: one is under way on the page, or this row's last is not read back. */
function useActionsWait(path: VaultPath): boolean {
  const busy = useContext(PageBusy);
  const settling = useContext(Settling);
  return busy || settling.has(path);
}

/**
 * What every row can do, the same object from one render to the next: the
 * app hands the page new callbacks on many of its renders, and a row handed a
 * new action is drawn again — all of them, for one tick (#217).
 */
function useRowActions(props: TodayPageProps, focus: RowFocus): RowActions {
  const { actedOn, rowRef } = focus;
  const onOpen = useSteadyCallback(props.onOpen);
  const onDone = useSteadyCallback(props.onDone);
  const onDefer = useSteadyCallback(props.onDefer);
  const onSetStatus = useSteadyCallback(props.onSetStatus);
  const onChoose = useSteadyCallback(props.onChoose);
  return useMemo(() => {
    const act = (task: TodayTask, action: () => void) => {
      actedOn(task.path);
      action();
    };
    return {
      rowRef,
      onOpen,
      onDone: (task) => act(task, () => onDone(rowOf(task))),
      onDefer: (task, days) => act(task, () => onDefer({ ...rowOf(task), days })),
      onMove: (task, status) => act(task, () => onSetStatus({ ...rowOf(task), status })),
      onChoose: (task, choice) =>
        act(task, () => onChoose({ ...rowOf(task), choice, ...laterChoiceMoved(task, choice) })),
    };
  }, [actedOn, rowRef, onOpen, onDone, onDefer, onSetStatus, onChoose]);
}

const rowOf = (task: TodayTask): RowTask => ({ path: task.path, title: task.title });

/** The later day a choice is moved from, when a task chosen for one is chosen for today. */
const laterChoiceMoved = (task: TodayTask, choice: TodayChoice) =>
  choice === 'choose' && task.laterChoice !== null ? { was: task.laterChoice } : {};

const NONE_SETTLING: ReadonlySet<VaultPath> = new Set();

/** What every row can do. */
interface RowActions {
  readonly rowRef: (path: VaultPath) => (element: HTMLElement | null) => void;
  readonly onOpen: (path: VaultPath) => void;
  readonly onDone: (task: TodayTask) => void;
  readonly onDefer: (task: TodayTask, days: number) => void;
  readonly onMove: (task: TodayTask, status: string) => void;
  readonly onChoose: (task: TodayTask, choice: TodayChoice) => void;
}

/** What a section hands each row: what the rows can do, and which have yet to be read back. */
interface RowsGiven {
  /** The rows acted on whose change the page has not read back: each takes no action until then. */
  readonly settling: ReadonlySet<VaultPath>;
  readonly actions: RowActions;
}

function Section({
  section,
  place,
  ...given
}: { section: TodaySection; place: ListPlace } & RowsGiven) {
  const title = TODAY_SECTION_LABELS[section.id];
  return (
    <section className="review__section" aria-label={title}>
      <h2 className="review__heading">
        {title} <span className="review__count">{section.count}</span>
      </h2>
      {section.id === 'waiting' && section.count > 0 && (
        <p className="review__note today__measure">
          Days are counted from each task’s last change — DFAI keeps no “waiting since”, so any edit
          to a task starts its count again.
        </p>
      )}
      {section.count === 0 ? (
        <p className="review__empty">{EMPTY[section.id]}</p>
      ) : (
        <SectionGroups section={section} place={place} {...given} />
      )}
    </section>
  );
}

/**
 * Heights a group and a row are placed by until they are measured, as WebKit
 * draws them: a row measured at its estimate does not place the list again.
 */
const GROUP_NAME_HEIGHT = 18;
/** Under the name: `.today__group-name`'s margin-bottom (today.css). */
const GROUP_NAME_GAP = 4;
const GROUP_GAP = 12;
/** The table view's row (table.css `.table__grid td`), pinned by e2e/row-estimates.spec.ts. */
const ROW_HEIGHT = 34;
/**
 * The half of the last row's 1px border that a collapsed table draws outside
 * itself: left out, every group was 0.5px short of what it measured, and the
 * page's scroll height moved under each fast scroll.
 */
const TABLE_EDGE = 0.5;

/**
 * A group's height before it is measured: the gap above it, its name and the
 * room under it, its rows, and the table's edge. Pinned to what a placed
 * group measures by e2e/row-estimates.spec.ts.
 */
function groupHeight(sectionId: TodaySectionId, group: TodayGroup | undefined, at: number): number {
  if (group === undefined) return 0;
  const named = (group.label ?? UNNAMED[sectionId] ?? null) !== null;
  return (
    (at === 0 ? 0 : GROUP_GAP) +
    (named ? GROUP_NAME_HEIGHT + GROUP_NAME_GAP : 0) +
    group.tasks.length * ROW_HEIGHT +
    TABLE_EDGE
  );
}

/**
 * A section's groups, only those near what the page shows put in it (#238):
 * a day can hold hundreds of projects with a next action each.
 */
function SectionGroups({
  section,
  place,
  ...given
}: { section: TodaySection; place: ListPlace } & RowsGiven) {
  const { groups } = section;
  const keys = useMemo(() => groups.map((group) => group.key), [groups]);
  const wanted = place.wanted;
  const content = useRef<HTMLDivElement>(null);
  const list = useVirtualRows({
    content,
    keys,
    estimate: (index) => groupHeight(section.id, groups[index], index),
    indexAttribute: 'data-group-index',
    overscan: 4,
    keepsEdges: false,
    pinned:
      wanted === null
        ? null
        : (groups.find((group) => group.tasks.some((task) => task.path === wanted))?.key ?? null),
  });
  return (
    <div className="today__groups" ref={content} onFocus={list.onFocus}>
      {list.placed.map(({ key, index, gapBefore }) => {
        const group = groups[index];
        if (group === undefined) return null;
        return (
          <Fragment key={key}>
            {gapBefore > 0 && <div aria-hidden="true" style={{ height: gapBefore }} />}
            <Group
              sectionId={section.id}
              group={group}
              at={index}
              measure={list.measure}
              place={place}
              {...given}
            />
          </Fragment>
        );
      })}
      {list.after > 0 && <div aria-hidden="true" style={{ height: list.after }} />}
    </div>
  );
}

/** What a section's unnamed group is called: the tasks under no project, or waiting on nobody. */
const UNNAMED: Partial<Record<TodaySectionId, string>> = {
  nextActions: 'No project',
  waiting: 'Nobody named',
};

/** Where a group sits in its section, and how it is measured there. */
interface GroupPlace {
  readonly at: number;
  readonly measure: (element: Element | null) => void;
  readonly place: ListPlace;
}

/** A group's cells: a Done box, the name, what the row says of it, and its commands. */
const ROW_CELLS = 4;

function Group({
  sectionId,
  group,
  at,
  measure,
  place,
  settling,
  actions,
}: { sectionId: TodaySectionId; group: TodayGroup } & GroupPlace & RowsGiven) {
  const name = group.label ?? UNNAMED[sectionId] ?? null;
  const keys = useMemo(() => group.tasks.map((task) => task.path), [group.tasks]);
  const body = useRef<HTMLTableSectionElement>(null);
  const rows = useVirtualRows({
    content: body,
    keys,
    estimate: () => ROW_HEIGHT,
    pinned: place.wanted,
  });
  return (
    <div
      ref={measure}
      data-group-index={at}
      className={at === 0 ? 'today__group' : 'today__group today__group--after'}
      role="group"
      aria-label={name ?? undefined}
    >
      {name !== null && (
        <h3 className="today__group-name">
          <GroupName group={group} name={name} onOpen={actions.onOpen} />
          {group.tasks.length > 0 && <span className="review__count">{group.tasks.length}</span>}
        </h3>
      )}
      <div className="table">
        <div className="table__sheet">
          <table className="table__grid review__grid" aria-rowcount={group.tasks.length}>
            <tbody ref={body} onFocus={rows.onFocus}>
              {rows.placed.map(({ key, index, gapBefore }) => {
                const task = group.tasks[index];
                if (task === undefined) return null;
                return (
                  <Fragment key={key}>
                    {gapBefore > 0 && <Spacer height={gapBefore} width={ROW_CELLS} />}
                    <tr
                      ref={rows.measure}
                      data-index={index}
                      aria-rowindex={index + 1}
                      className="table__row"
                      data-today-row={task.path}
                      aria-busy={settling.has(task.path) || undefined}
                    >
                      <TaskRow task={task} sectionId={sectionId} actions={actions} />
                    </tr>
                  </Fragment>
                );
              })}
              {rows.after > 0 && <Spacer height={rows.after} width={ROW_CELLS} />}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function GroupName({
  group,
  name,
  onOpen,
}: {
  group: TodayGroup;
  name: string;
  onOpen: (path: VaultPath) => void;
}) {
  const { project } = group;
  // The name can be cut to an ellipsis on its one line; the tooltip says it whole.
  if (project === null) return <span title={name}>{name}</span>;
  return (
    <button type="button" className="today__project" title={name} onClick={() => onOpen(project)}>
      {name}
    </button>
  );
}

/**
 * One task's row — its cells; the `<tr>` around them is placed by its group's
 * list — drawn again only when its task or its standing changes: the page can
 * hold hundreds, and a tick drew every one of them again (#217). The page's
 * busy, and which rows are settling, reach only its action controls
 * (`useActionsWait`).
 */
const TaskRow = memo(function TaskRow({
  task,
  sectionId,
  actions,
}: {
  task: TodayTask;
  sectionId: TodaySectionId;
  actions: RowActions;
}) {
  return (
    <>
      <td className="table__done">
        <DoneBox task={task} actions={actions} />
      </td>
      <td className="table__name">
        <button type="button" className="table__link" onClick={() => actions.onOpen(task.path)}>
          <span className="table__title">{task.title}</span>
        </button>
      </td>
      <td className="review__detail today__detail">
        {rowDetails({ task, sectionId, onOpen: actions.onOpen })}
      </td>
      <td className="review__actions">
        <RowCommands task={task} sectionId={sectionId} actions={actions} />
      </td>
    </>
  );
});

interface RowControlProps {
  readonly task: TodayTask;
  readonly actions: RowActions;
}

function DoneBox({ task, actions }: RowControlProps) {
  const waits = useActionsWait(task.path);
  return (
    <input
      ref={actions.rowRef(task.path)}
      type="checkbox"
      className="done-check"
      aria-label={`Mark ${task.title} done`}
      aria-keyshortcuts="x"
      checked={false}
      // Held, not disabled: it is the row's handle, and WebKit drops the focus
      // of a control it disables — the keys after an action would land nowhere.
      {...heldWhile(waits, true)}
      onChange={() => {
        if (!waits) actions.onDone(task);
      }}
    />
  );
}

/**
 * A row's choice for today, Move to… and Defer buttons. Elements, not
 * components of their own: each component a row holds is a render "Open
 * Today" is counted by (tools/perf/budgets.json).
 */
function RowCommands({
  task,
  sectionId,
  actions,
}: RowControlProps & { sectionId: TodaySectionId }) {
  const waits = useActionsWait(task.path);
  // No choice where the vault does not choose, nor over a focus that is the person's own.
  const chooses = useContext(Choosing) && task.focusIsOwn !== true;
  return (
    <>
      {chooses &&
        (sectionId === 'carriedOver'
          ? carriedChoices({ task, waits, actions })
          : todayToggle({
              title: task.title,
              chosen: sectionId === 'chosen',
              disabled: waits,
              keyShortcut: 't',
              onToggle: () =>
                actions.onChoose(task, sectionId === 'chosen' ? 'unchoose' : 'choose'),
            }))}
      <MoveMenu
        title={task.title}
        statuses={todayMovesFor(task.status)}
        busy={waits}
        keyShortcut="m"
        onMove={(status) => actions.onMove(task, status)}
      />
      {TODAY_DEFER_DAYS.map((days) => (
        <button
          key={days}
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label={`Defer ${task.title} ${days === 1 ? '1 day' : `${days} days`}`}
          {...(days === TODAY_DEFER_DAYS[0] && { 'aria-keyshortcuts': 'd' })}
          title={days === 1 ? 'Defer until tomorrow' : `Defer for ${days} days`}
          disabled={waits}
          onClick={() => actions.onDefer(task, days)}
        >
          +{days}d
        </button>
      ))}
    </>
  );
}

interface ChoiceControls extends RowControlProps {
  readonly waits: boolean;
}

/** Keep, which chooses a task carried over for today, and Drop, which lets the choice go. */
function carriedChoices({ task, waits, actions }: ChoiceControls) {
  return (
    <>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label={`Keep ${task.title} for today`}
        aria-keyshortcuts="t"
        disabled={waits}
        onClick={() => actions.onChoose(task, 'keep')}
      >
        Keep
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label={`Drop ${task.title} from today`}
        disabled={waits}
        onClick={() => actions.onChoose(task, 'drop')}
      >
        Drop
      </button>
    </>
  );
}

/** The sections whose tasks are of mixed statuses, so each row says its own. */
const SAYS_STATUS: ReadonlySet<TodaySectionId> = new Set([
  'chosen',
  'carriedOver',
  'overdue',
  'dueToday',
  'backToday',
]);

/**
 * What a row says of its task beside the name: its status where the section
 * mixes them, its project and who it waits on where the group does not
 * already say, its contexts, its day, and how long it has waited — on one
 * line, a · between each (the brief, §3). A function the row calls, not a
 * component: the 34px rows put more of them on the page, and each
 * component a row holds is a render "Open Today" is counted by
 * (tools/perf/budgets.json).
 */
function rowDetails({
  task,
  sectionId,
  onOpen,
}: {
  task: TodayTask;
  sectionId: TodaySectionId;
  onOpen: (path: VaultPath) => void;
}) {
  const { project, projectTitle } = task;
  const pieces: ReactNode[] = [];
  if (SAYS_STATUS.has(sectionId) && task.status !== null) {
    pieces.push(<StatusPill key="status" value={task.status} />);
  }
  if (sectionId !== 'nextActions' && project !== null) {
    pieces.push(
      <button
        key="project"
        type="button"
        className="today__project"
        onClick={() => onOpen(project)}
      >
        {projectTitle}
      </button>,
    );
  }
  task.contexts.forEach((context, at) => {
    // By place: a task may name one context twice.
    pieces.push(<span key={`context ${at}`}>{context}</span>);
  });
  if (sectionId !== 'waiting' && task.status === 'waiting' && task.waitingOn !== '') {
    pieces.push(<span key="on">On {task.waitingOn}</span>);
  }
  if (task.due !== null) pieces.push(dueDay(task, sectionId));
  if (sectionId === 'carriedOver' && task.focus !== undefined && task.focus !== null) {
    pieces.push(<span key="chosen">Chosen for {task.focus}</span>);
  }
  if (task.laterChoice !== null) {
    pieces.push(<span key="later">Chosen for {task.laterChoice}</span>);
  }
  if (sectionId === 'backToday' && task.defer !== null) {
    pieces.push(<span key="back">Deferred until {task.defer}</span>);
  }
  if (task.waitingDays !== null) {
    pieces.push(<span key="waited">{waitedWords(task.waitingDays)}</span>);
  }
  return (
    <span className="today__pieces">
      {pieces.flatMap((piece, at) =>
        at === 0
          ? [piece]
          : [
              <span key={`sep ${at}`} className="today__sep" aria-hidden="true">
                ·
              </span>,
              piece,
            ],
      )}
    </span>
  );
}

function dueDay(task: TodayTask, sectionId: TodaySectionId): ReactNode {
  if (sectionId === 'dueToday') return <span key="due">Due today</span>;
  return (
    <span key="due" className={sectionId === 'overdue' ? 'today__late' : undefined}>
      Due {task.due}
    </span>
  );
}

/** How long a Waiting task has waited, and from what: its file's last change. */
function waitedWords(days: number): string {
  if (days === 0) return 'Less than a day since last change';
  return `${days === 1 ? '1 day' : `${days} days`} since last change`;
}
