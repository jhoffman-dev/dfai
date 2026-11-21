import type { ReactNode } from 'react';
import {
  GTD_STATUS_LABELS,
  humanizeKey,
  isGtdStatus,
  REVIEW_MOVES,
  STALE_WAITING_DAYS,
  UNTOUCHED_SOMEDAY_DAYS,
  type ReviewProject,
  type ReviewTask,
  type VaultPath,
} from '@dfai/domain';
import type { WeeklyReviewReport } from '@dfai/application';
import { Icon } from './icon.tsx';
import { PageBar, type PageHistory } from './page-bar.tsx';
import { HiddenTitle } from './page-head.tsx';

export interface WeeklyReviewPageProps {
  /** Null while the index is being asked. */
  review: WeeklyReviewReport | null;
  error: string | null;
  /** The statuses a project's type offers, for moving one on. */
  projectStatuses: readonly string[];
  /** While an item is being acted on, so nothing is asked for twice. */
  busy: boolean;
  /** Why the last action could not be done, or null. */
  problem: string | null;
  onOpen: (path: VaultPath) => void;
  onOpenInbox: () => void;
  /** Gives a task another status. */
  onSetStatus: (args: { path: VaultPath; status: string }) => void;
  /** Gives a project another status. */
  onSetProjectStatus: (args: { path: VaultPath; status: string }) => void;
  /** Puts a task off for a week. */
  onDefer: (path: VaultPath) => void;
  /** Finishes a task. */
  onArchiveTask: (path: VaultPath) => void;
  /** Moves a project into the Archive. */
  onArchiveProject: (path: VaultPath) => void;
  onShowSidebar?: () => void;
  history?: PageHistory;
}

/**
 * The weekly review (P30-07): GTD's questions of the week in one place —
 * what has waited too long, which projects have nothing next, what is late,
 * which ideas have gone untouched, and what waits in the Inbox — each item a
 * click from opening and one action from being dealt with.
 */
export function WeeklyReviewPage(props: WeeklyReviewPageProps) {
  const counted = describe(props.review);
  return (
    <>
      <PageBar
        crumb={{ icon: 'calendar', parent: 'Review' }}
        name="This week"
        {...(counted !== null && { count: counted })}
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="panel__body">
        <article className="page page--wide review" aria-label="Weekly review">
          <HiddenTitle>This week</HiddenTitle>
          {props.problem !== null && (
            <p className="table__error" role="alert">
              {props.problem}
            </p>
          )}
          <ReviewBody {...props} />
        </article>
      </div>
    </>
  );
}

function describe(review: WeeklyReviewReport | null): string | null {
  if (review === null) return null;
  const left = [
    review.staleWaiting,
    review.projectsWithoutNextAction,
    review.overdue,
    review.untouchedSomeday,
  ].reduce((sum, items) => sum + items.length, 0);
  const asOf = `As of ${review.today}`;
  return left === 0 ? `${asOf} · nothing to review` : `${asOf} · ${left} to look at`;
}

function ReviewBody(props: WeeklyReviewPageProps) {
  const { review, error } = props;
  if (error !== null) {
    return (
      <p className="table__error" role="alert">
        {error}
      </p>
    );
  }
  if (review === null) return <p className="table__empty">Reading the week…</p>;
  return (
    <>
      {review.truncated && (
        <p className="review__note">
          The vault holds more tasks than the review reads at once, so some may be missing.
        </p>
      )}
      <InboxSection inbox={review.inbox} onOpenInbox={props.onOpenInbox} />
      <TaskSection
        title={`Waiting for more than ${STALE_WAITING_DAYS} days`}
        empty="Nothing has waited that long."
        tasks={review.staleWaiting}
        moves={REVIEW_MOVES.staleWaiting}
        detail={(task) => (task.waitingOn === '' ? 'Waiting on nobody' : `On ${task.waitingOn}`)}
        actions={props}
      />
      <ProjectSection projects={review.projectsWithoutNextAction} actions={props} />
      <TaskSection
        title="Overdue"
        empty="Nothing is late."
        tasks={review.overdue}
        moves={REVIEW_MOVES.overdue}
        detail={(task) =>
          `Due ${task.due ?? ''}${task.dueTime === undefined ? '' : ` at ${task.dueTime}`}`
        }
        actions={props}
      />
      <TaskSection
        title={`Someday and Longterm, untouched for ${UNTOUCHED_SOMEDAY_DAYS} days`}
        empty="Every idea has been looked at this month."
        tasks={review.untouchedSomeday}
        moves={REVIEW_MOVES.untouchedSomeday}
        detail={(task) => (task.status === null ? '' : GTD_STATUS_LABELS[task.status])}
        actions={props}
      />
    </>
  );
}

function InboxSection({
  inbox,
  onOpenInbox,
}: {
  inbox: WeeklyReviewReport['inbox'];
  onOpenInbox: () => void;
}) {
  const count = `${inbox.count}${inbox.more ? '+' : ''}`;
  return (
    <section className="review__section" aria-label="Inbox">
      <h2 className="review__heading">
        Inbox <span className="review__count">{count}</span>
      </h2>
      <div className="review__inbox">
        <p>{inbox.count === 0 ? 'Nothing waits to be processed.' : `${count} to process.`}</p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenInbox}>
          Open the Inbox
        </button>
      </div>
    </section>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="review__section" aria-label={title}>
      <h2 className="review__heading">
        {title} <span className="review__count">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="review__empty">{empty}</p>
      ) : (
        <div className="table">
          <div className="table__sheet">
            <table className="table__grid review__grid">
              <tbody>{children}</tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function TaskSection({
  title,
  empty,
  tasks,
  moves,
  detail,
  actions,
}: {
  title: string;
  empty: string;
  tasks: readonly ReviewTask[];
  /** The statuses Move offers here: those that take a task out of this section. */
  moves: readonly string[];
  detail: (task: ReviewTask) => string;
  actions: WeeklyReviewPageProps;
}) {
  return (
    <Section title={title} count={tasks.length} empty={empty}>
      {tasks.map((task) => (
        <ReviewRow
          key={task.path}
          path={task.path}
          title={task.title}
          detail={detail(task)}
          onOpen={actions.onOpen}
        >
          <StatusPicker
            title={task.title}
            current={task.status}
            choices={moves}
            label={(status) => (isGtdStatus(status) ? GTD_STATUS_LABELS[status] : status)}
            onPick={(status) => actions.onSetStatus({ path: task.path, status })}
            busy={actions.busy}
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label={`Defer ${task.title} a week`}
            disabled={actions.busy}
            onClick={() => actions.onDefer(task.path)}
          >
            Defer
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label={`Archive ${task.title}`}
            disabled={actions.busy}
            onClick={() => actions.onArchiveTask(task.path)}
          >
            Archive
          </button>
        </ReviewRow>
      ))}
    </Section>
  );
}

function ProjectSection({
  projects,
  actions,
}: {
  projects: readonly ReviewProject[];
  actions: WeeklyReviewPageProps;
}) {
  return (
    <Section
      title="Active projects with no next action"
      count={projects.length}
      empty="Every active project has something to do next."
    >
      {projects.map((project) => (
        <ReviewRow
          key={project.path}
          path={project.path}
          title={project.title}
          detail="Nothing to do next"
          onOpen={actions.onOpen}
        >
          <StatusPicker
            title={project.title}
            current={project.status}
            choices={actions.projectStatuses}
            label={humanizeKey}
            onPick={(status) => actions.onSetProjectStatus({ path: project.path, status })}
            busy={actions.busy}
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label={`Archive ${project.title}`}
            disabled={actions.busy}
            onClick={() => actions.onArchiveProject(project.path)}
          >
            Archive
          </button>
        </ReviewRow>
      ))}
    </Section>
  );
}

function ReviewRow({
  path,
  title,
  detail,
  onOpen,
  children,
}: {
  path: VaultPath;
  title: string;
  detail: string;
  onOpen: (path: VaultPath) => void;
  children: ReactNode;
}) {
  return (
    <tr className="table__row">
      <td className="table__name">
        <button type="button" className="table__link" onClick={() => onOpen(path)}>
          <Icon name="doc" size={16} />
          <span className="table__title">{title}</span>
        </button>
      </td>
      <td className="review__detail">{detail}</td>
      <td className="review__actions">{children}</td>
    </tr>
  );
}

function StatusPicker({
  title,
  current,
  choices,
  label,
  onPick,
  busy,
}: {
  title: string;
  current: string | null;
  choices: readonly string[];
  label: (status: string) => string;
  onPick: (status: string) => void;
  busy: boolean;
}) {
  const offered = choices.filter((status) => status !== current);
  return (
    <select
      className="review__status"
      aria-label={`Move ${title} to`}
      value=""
      disabled={busy || offered.length === 0}
      onChange={(event) => {
        if (event.target.value !== '') onPick(event.target.value);
      }}
    >
      <option value="">Move to…</option>
      {offered.map((status) => (
        <option key={status} value={status}>
          {label(status)}
        </option>
      ))}
    </select>
  );
}
