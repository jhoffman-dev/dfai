import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PROJECT_STATUS_KEY,
  PROJECT_TYPE,
  reviewDeferral,
  TASK_KEYS,
  tasksStartInInbox,
  taskTypeOf,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import {
  archiveTaskChange,
  readWeeklyReview,
  type ActivityLog,
  type Clock,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
  type WeeklyReviewReport,
} from '@dfai/application';
import type { OpenEditors } from '../panes/open-editors.ts';
import { errorMessage } from '../query/error-message.ts';
import { useReviewWrites } from './use-review-writes.ts';

export interface WeeklyReviewOptions {
  readonly ports: {
    readonly index: Pick<IndexPort, 'query'>;
    readonly fs: VaultFsPort;
    readonly markdown: MarkdownPort;
  };
  /** A note open in a pane is written through the pane, as every view writes it. */
  readonly editors: OpenEditors;
  readonly clock: Pick<Clock, 'today' | 'now'>;
  /** The vault's types: the review is offered once tasks are, and a project moves among its type's statuses. */
  readonly types: readonly ObjectType[];
  /** Changes when the index does, so the review shows what it now holds. */
  readonly indexKey: string;
  /** Whether the index is ready to be asked; while it builds, nothing is read or shown. Ready unless said. */
  readonly indexReady?: boolean;
  /** Whether the review is showing, which is when it is read. */
  readonly open: boolean;
  /** Re-reads the tree and the index once an item has been acted on. */
  readonly onSettled: () => void;
  /** Moves a project into the Archive, as the app's Archive command does. */
  readonly archiveNote: (path: VaultPath) => Promise<unknown>;
  /** Where a write the review gives up on is recorded; a task rule's refusal is not. */
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
}

/**
 * The weekly review page (P30-07): the review as the index has it, and its
 * quick actions. Each action is a write every other view makes — a status,
 * a defer, a finish, held to the task rules where the write lands — so an
 * item leaves its section once the index has the change.
 */
export function useWeeklyReview(options: WeeklyReviewOptions) {
  const { ports, editors, clock, types, indexKey, open, onSettled, archiveNote, activity } =
    options;
  const indexReady = options.indexReady ?? true;
  const [read, setRead] = useState<ReadFrom | null>(null);
  // The types the sidebar's Inbox count is read with, so the review counts the same.
  const startInInbox = tasksStartInInbox(types);

  // The parts of the ports the read is made through: the window hands new
  // ports each time it lists the tree again, which is no reason to read (#325).
  const { index, fs, markdown } = ports;
  useEffect(() => {
    if (!open || !indexReady) return;
    let cancelled = false;
    readWeeklyReview({ index, fs, markdown, clock, tasksStartInInbox: startInInbox })
      .then((report) => {
        if (!cancelled) setRead({ index, report, error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setRead({ index, report: null, error: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [index, fs, markdown, clock, indexKey, indexReady, open, startInInbox]);

  // Only what this index answered, and only while it is ready: after a vault
  // switch or during a rebuild the last review's paths are not this vault's,
  // so it is not shown — nor are its actions offered — until the read is in.
  const current = indexReady && read !== null && read.index === ports.index ? read : null;

  const { busy, problem, setProblem, act, write } = useReviewWrites({
    ports,
    editors,
    clock,
    onSettled,
    activity,
  });

  const setStatus = useCallback(
    ({ path, status }: { path: VaultPath; status: string }) =>
      void write(path, { [TASK_KEYS.status]: status }),
    [write],
  );
  const setProjectStatus = useCallback(
    ({ path, status }: { path: VaultPath; status: string }) =>
      void write(path, { [PROJECT_STATUS_KEY]: status }),
    [write],
  );
  const defer = useCallback(
    (path: VaultPath) => {
      const deferral = reviewDeferral(clock.today());
      if (deferral === null) setProblem('Today’s date could not be read, so nothing was deferred.');
      else void write(path, deferral);
    },
    [write, clock, setProblem],
  );
  const archiveTask = useCallback(
    (path: VaultPath) => void write(path, archiveTaskChange()),
    [write],
  );
  const archiveProject = useCallback(
    (path: VaultPath) => void act(() => archiveNote(path)),
    [act, archiveNote],
  );

  const projectStatuses = useMemo(() => projectStatusesOf(types), [types]);
  return {
    /** Whether the vault has tasks to review, which is when its sidebar row shows. */
    shown: taskTypeOf(types) !== null,
    page: {
      review: current?.report ?? null,
      error: current?.error ?? null,
      projectStatuses,
      busy,
      problem,
      onSetStatus: setStatus,
      onSetProjectStatus: setProjectStatus,
      onDefer: defer,
      onArchiveTask: archiveTask,
      onArchiveProject: archiveProject,
    },
  };
}

/** A read of the review, and the index it was read from. */
interface ReadFrom {
  readonly index: unknown;
  readonly report: WeeklyReviewReport | null;
  readonly error: string | null;
}

/** The options of the project type's `status`, which the review moves a project among. */
function projectStatusesOf(types: readonly ObjectType[]): readonly string[] {
  const project = types.find((type) => type.name === PROJECT_TYPE);
  return project?.properties.find((property) => property.key === PROJECT_STATUS_KEY)?.options ?? [];
}
