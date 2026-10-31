import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GTD_STATUSES,
  isGtdStatus,
  noteTitle,
  undoStillOffered,
  type GtdStatus,
} from '@dfai/domain';
import {
  dismissMigrationUndo,
  hasMigrationWork,
  previewTaskMigration,
  readMigrationRecord,
  runTaskMigration,
  taskMigrationNeeded,
  undoTaskMigration,
  type ActivityRecorder,
  type ArchivePorts,
  type LeftFile,
  type TaskMigrationPorts,
  type TaskMigrationPreview,
} from '@dfai/application';
import type { TaskMigrationPreviewData, TaskMigrationProps } from '@dfai/ui';
import { localClock, localDayOf, localToday } from '../today.ts';
import { keepIfSame } from '../same-reading.ts';

const files = (count: number) => (count === 1 ? '1 file' : `${count} files`);
const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The preview, read only when the quick look says the move may have something left to do. */
async function previewIfNeeded(
  ports: TaskMigrationPorts,
  chosen: ReadonlyMap<string, GtdStatus>,
): Promise<TaskMigrationPreview | null> {
  if (!(await taskMigrationNeeded(ports))) return null;
  return previewTaskMigration(ports, chosen);
}

/** The preview as the panel draws it: plain rows, the old statuses counted. */
function previewData(preview: TaskMigrationPreview): TaskMigrationPreviewData {
  const holding = (status: string) => preview.tasks.filter((task) => task.from === status).length;
  return {
    mapping: [...preview.mapping].map(([from, to]) => ({ from, to, tasks: holding(from) })),
    statuses: GTD_STATUSES,
    typeLines: preview.type?.lines ?? [],
    tasks: preview.tasks,
    references: preview.references,
    listed: preview.listed,
    views: preview.views.map(noteTitle),
  };
}

/**
 * Moving the vault's tasks to GTD's eight statuses (P30-02), from the Inbox
 * page: what the move would do is read while the page shows, and nothing is
 * written until the person runs it from the preview. A run and an undo are
 * each said in Activity, with every file left as it was and why — nothing
 * about a migration that rewrites every task is silent. The undo is offered
 * once (#163): for a week after the run, until dismissed.
 */
export function useTaskMigration({
  ports,
  vaultKey,
  indexReady,
  open,
  activity,
  onChanged,
}: {
  ports: ArchivePorts;
  vaultKey: string | null;
  indexReady: boolean;
  /** Whether the Inbox page is showing: the tasks are read ahead once the index is ready, then again as it opens (#130). */
  open: boolean;
  activity: ActivityRecorder;
  /** After the move or its undo wrote files, so the types, tree and index are read again. */
  onChanged: () => void;
}): TaskMigrationProps | null {
  const [preview, setPreview] = useState<TaskMigrationPreview | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [chosen, setChosen] = useState<ReadonlyMap<string, GtdStatus>>(new Map());
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The vault last previewed for the offer: until this one is, the Inbox holds its rows (#130).
  const [previewedFor, setPreviewedFor] = useState<string | null>(null);
  // Read in the effect, which runs the first preview as soon as the index is ready —
  // before the Inbox opens, so opening it usually waits for nothing — and again on each open.
  const prefetched = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  // `busy` reaches the panel a render late; a double click would run twice.
  const running = useRef(false);

  const migrationPorts = useMemo(
    () => ({ fs: ports.fs, markdown: ports.markdown, index: ports.index, dayOf: localDayOf }),
    [ports.fs, ports.markdown, ports.index],
  );

  useEffect(() => {
    setPreview(null);
    setCanUndo(false);
    setChosen(new Map());
    setExpanded(false);
    setDismissed(false);
    setResult(null);
    setProblem(null);
  }, [vaultKey]);

  useEffect(() => {
    if (!indexReady || vaultKey === null) return;
    if (!open && prefetched.current === vaultKey) return;
    let cancelled = false;
    // Read apart: a run's undo is offered even when the tasks cannot be read now.
    // The preview alone holds the Inbox's rows (#130): set with it, so it costs no commit of its own.
    previewIfNeeded(migrationPorts, chosen)
      .then((read) => {
        if (cancelled) return;
        const now = read !== null && hasMigrationWork(read) ? read : null;
        setPreview((was) => keepIfSame(was, now));
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setProblem(`Your tasks could not be read for GTD: ${reasonOf(cause)}`);
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      });
    readMigrationRecord(migrationPorts.fs)
      .then((record) => {
        if (!cancelled)
          setCanUndo(record !== null && undoStillOffered(record.record, localToday()));
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setProblem(`The move to GTD's record could not be read: ${reasonOf(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [migrationPorts, open, indexReady, vaultKey, chosen, revision]);

  /** Each file left as it was, in Activity, so none is left silently. */
  const reportLeft = useCallback(
    (doing: string, left: readonly LeftFile[]) => {
      for (const { path, reason } of left) {
        activity.record({
          level: 'warning',
          kind: 'app',
          message: `${doing} left ${noteTitle(path)} as it was: ${reason}`,
          subject: { kind: 'note', path },
        });
      }
    },
    [activity],
  );

  const settle = useCallback(
    async (work: () => Promise<string>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setProblem(null);
      try {
        setResult(await work());
        setExpanded(false);
      } catch (cause) {
        const message = reasonOf(cause);
        setProblem(message);
        activity.record({ level: 'error', kind: 'app', message, subject: null });
      } finally {
        running.current = false;
        setBusy(false);
        setRevision((at) => at + 1);
        onChanged();
      }
    },
    [activity, onChanged],
  );

  const run = useCallback(() => {
    if (preview === null) return;
    void settle(async () => {
      const report = await runTaskMigration({
        ports: migrationPorts,
        panes: ports.editors,
        clock: localClock,
        preview,
      });
      const said = `Moved tasks to GTD statuses: ${files(report.written.length)} changed or added${report.left.length === 0 ? '' : `, ${files(report.left.length)} left as they were`}. It can be undone from the Inbox.`;
      activity.record({ level: 'info', kind: 'app', message: said, subject: null });
      reportLeft('Moving tasks to GTD', report.left);
      return said;
    });
  }, [preview, settle, migrationPorts, ports.editors, activity, reportLeft]);

  const undo = useCallback(() => {
    void settle(async () => {
      const undone = await undoTaskMigration({ fs: ports.fs, panes: ports.editors });
      const said =
        undone === null
          ? 'There was no move to GTD to undo.'
          : `Undid the move to GTD: ${files(undone.restored.length)} put back${undone.left.length === 0 ? '' : `, ${files(undone.left.length)} left as they are`}.`;
      activity.record({ level: 'info', kind: 'app', message: said, subject: null });
      reportLeft('Undoing the move to GTD', undone?.left ?? []);
      return said;
    });
  }, [settle, ports.fs, ports.editors, activity, reportLeft]);

  const dismiss = useCallback(() => {
    // Gone at once, as asked; the record is told so the offer stays gone after a restart.
    setCanUndo(false);
    setResult(null);
    dismissMigrationUndo(ports.fs).catch((cause: unknown) => {
      const message = `The undo could not be dismissed for good: ${reasonOf(cause)}`;
      setProblem(message);
      activity.record({ level: 'error', kind: 'app', message, subject: null });
    });
  }, [ports.fs, activity]);

  const choose = useCallback(({ from, to }: { from: string; to: string }) => {
    if (!isGtdStatus(to)) return;
    setChosen((was) => new Map([...was, [from, to]]));
  }, []);

  const reading = open && vaultKey !== null && previewedFor !== vaultKey;
  const waitingForIndex = reading && !indexReady;
  if (!reading && preview === null && !canUndo && result === null && problem === null) return null;
  return {
    reading,
    waitingForIndex,
    preview: dismissed || preview === null ? null : previewData(preview),
    open: expanded,
    busy,
    result,
    problem,
    canUndo,
    onOpen: () => setExpanded(true),
    onChoose: choose,
    onRun: run,
    onClose: () => {
      if (expanded) setExpanded(false);
      else setDismissed(true);
    },
    onUndo: undo,
    onDismiss: dismiss,
  };
}
