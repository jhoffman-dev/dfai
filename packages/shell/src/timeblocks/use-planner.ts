import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createVaultPath,
  messageWithoutPaths,
  newBlockLength,
  noteTitle,
  slotValue,
  type ObjectType,
  type TrayTask,
} from '@dfai/domain';
import {
  addTaskToBlock,
  BlockBeingEditedError,
  BlockChangedError,
  BlockTimesError,
  createBlockForTask,
  NotABlockError,
  readPlanTray,
  TaskRuleRefusedError,
  undoScheduling,
  type ActivityLog,
  type IndexPort,
  type MarkdownPort,
  type Scheduling,
  type VaultFsPort,
  type WriteNoteProperties,
} from '@dfai/application';
import type { PlanDrop, Planner } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import type { OpenEditors, PaneEditors } from '../panes/open-editors.ts';
import { writeNoteProperties } from '../query/use-view-writes.ts';
import { localToday } from '../today.ts';

/**
 * What a drop or its Undo refuses to do so as not to lose or break something —
 * shown in the tray for the person to act on, and no fault to record.
 */
const PLANNING_REFUSALS = [
  TaskRuleRefusedError,
  BlockTimesError,
  BlockChangedError,
  BlockBeingEditedError,
  NotABlockError,
];

/** The last drop, in the vault it was made in, so another vault's is never undone here. */
interface LastDrop {
  readonly vault: string | null;
  readonly scheduling: Scheduling;
  readonly title: string;
}

/** What the tray says of a drop, beside its Undo. */
function saidOf({ scheduling, title }: LastDrop): string {
  const block = noteTitle(scheduling.block);
  return scheduling.kind === 'created'
    ? `Planned ${title} in ${block}.`
    : `Added ${title} to ${block}.`;
}

/**
 * Minutes that drops made since the tray last read give each task, so a
 * second drop before the tray reads again is sized by what the first left.
 * A drop's minutes are let go once a read that began after its block was
 * written has finished — that read counts the block itself — or as soon as
 * its write fails.
 */
function usePlacedSince() {
  const reads = useRef(0);
  const placed = useRef(new Set<{ path: string; minutes: number; settledBefore: number | null }>());

  const sum = useCallback(
    (path: string) =>
      [...placed.current].reduce((acc, drop) => (drop.path === path ? acc + drop.minutes : acc), 0),
    [],
  );
  const add = useCallback((path: string, minutes: number) => {
    const drop = { path, minutes, settledBefore: null as number | null };
    placed.current.add(drop);
    return {
      written: () => {
        drop.settledBefore = reads.current + 1;
      },
      failed: () => placed.current.delete(drop),
    };
  }, []);
  /** A read starting: call what it answers with once it has finished. */
  const reading = useCallback(() => {
    const read = (reads.current += 1);
    return () => {
      for (const drop of placed.current) {
        if (drop.settledBefore !== null && drop.settledBefore <= read) placed.current.delete(drop);
      }
    };
  }, []);
  return useMemo(() => ({ sum, add, reading }), [sum, add, reading]);
}

/**
 * Planning the day on a calendar of blocks (P31-02): the next actions for the
 * tray, read again whenever the index changes; a task let go on empty time
 * made into a block sized to what it still needs, or linked into the block it
 * was let go on; and the last drop, to undo. Every write goes through the
 * task rules' chokepoints — a new note through `createNote`, a block's tasks
 * through a pane holding it or `setNoteProperties`. Null when `active` is
 * false: the calendar is not one of blocks, and nothing is read.
 *
 * Drops may settle out of order: the one started last that did something is
 * the one Undo takes back. Undo runs once at a time; a press while it runs
 * does nothing.
 */
export function usePlanner({
  active,
  vault,
  fs,
  markdown,
  index,
  editors,
  types,
  notePaths,
  indexKey,
  onChanged,
  activity,
}: {
  active: boolean;
  vault: string | null;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  /** The panes: a block's tasks are written through one holding it; Undo asks whether one is typing in it. */
  editors: OpenEditors & Pick<PaneEditors, 'stateOf'>;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  indexKey: string;
  /** After a block is written, so the calendar and the tray read it. */
  onChanged: () => void;
  /** Where a drop or an Undo the tray gives up on is recorded; a refusal is not. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
}): Planner | null {
  const [tasks, setTasks] = useState<readonly TrayTask[] | null>(null);
  const [readProblem, setReadProblem] = useState<string | null>(null);
  const [writeProblem, setWriteProblem] = useState<string | null>(null);
  const [last, setLast] = useState<LastDrop | null>(null);
  const paths = useMemo(() => notePaths.map(createVaultPath), [notePaths]);
  const placedSince = usePlacedSince();
  const drops = useRef({ started: 0, recorded: 0 });
  const undoing = useRef(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = placedSince.reading();
    readPlanTray({ index, types, notePaths })
      .then((answer) => {
        read();
        if (cancelled) return;
        setTasks(answer);
        setReadProblem(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setReadProblem(`The next actions could not be read: ${messageWithoutPaths(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [active, index, types, notePaths, indexKey, placedSince]);

  const writeProperties = useCallback<WriteNoteProperties>(
    async ({ path, values }) => {
      await writeNoteProperties({ editors, fs, markdown, path, values });
    },
    [editors, fs, markdown],
  );

  /**
   * Runs a write, then has everything read again; a failure is said in the
   * tray, and recorded in the Activity log unless it was a refusal.
   */
  const settle = useCallback(
    (write: Promise<LastDrop | null>, onDone: (drop: LastDrop | null) => void) => {
      setWriteProblem(null);
      const named = { activity, write: 'block', path: null, refusal: PLANNING_REFUSALS } as const;
      return withGiveUpRecorded(named, () => write)
        .then((drop) => {
          onDone(drop);
          onChanged();
        })
        .catch((cause: unknown) => setWriteProblem(messageWithoutPaths(cause)));
    },
    [onChanged, activity],
  );

  const scheduleDrop = useCallback(
    (drop: PlanDrop) => {
      const task = { path: createVaultPath(drop.task.path), title: drop.task.title };
      if (drop.kind === 'block') {
        return addTaskToBlock({
          writeProperties,
          block: createVaultPath(drop.block),
          task: task.path,
          notePaths: paths,
        });
      }
      const minutes = newBlockLength(drop.task.schedule, placedSince.sum(drop.task.path));
      const placed = placedSince.add(drop.task.path, minutes);
      const made = createBlockForTask({
        fs,
        markdown,
        types,
        task,
        start: slotValue(drop.date, drop.minutes),
        minutes,
        notePaths: paths,
        today: localToday(),
      });
      made.then(placed.written, placed.failed);
      return made;
    },
    [fs, markdown, types, paths, writeProperties, placedSince],
  );

  const place = useCallback(
    (drop: PlanDrop) => {
      const started = (drops.current.started += 1);
      const kept = scheduleDrop(drop).then((scheduling) =>
        scheduling === null ? null : { vault, scheduling, title: drop.task.title },
      );
      // A drop onto a block already holding the task did nothing, and one
      // started before the last recorded settled late: either way, the last stays undoable.
      void settle(kept, (done) => {
        if (done === null || started < drops.current.recorded) return;
        drops.current.recorded = started;
        setLast(done);
      });
    },
    [scheduleDrop, vault, settle],
  );

  const undo = useMemo(() => {
    if (last === null || last.vault !== vault) return null;
    const run = () => {
      if (undoing.current) return;
      undoing.current = true;
      void settle(
        undoScheduling({
          scheduling: last.scheduling,
          fs,
          index,
          editors: { state: editors.stateOf },
          writeProperties,
          notePaths: paths,
        }).then(() => null),
        // A drop recorded while the undo ran is the next to undo, and stays.
        () => setLast((current) => (current === last ? null : current)),
      ).finally(() => {
        undoing.current = false;
      });
    };
    return { said: saidOf(last), run };
  }, [last, vault, settle, fs, index, editors, writeProperties, paths]);

  const problem = writeProblem ?? readProblem;
  return useMemo(
    () => (active ? { tasks, problem, place, undo } : null),
    [active, tasks, problem, place, undo],
  );
}
