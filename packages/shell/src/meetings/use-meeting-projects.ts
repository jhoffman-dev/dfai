import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isFiledByDefault,
  NO_SERIES_PROJECT,
  noteTitle,
  projectBackfillLine,
  projectBackfillUndoLine,
  type ProjectBackfillRow,
} from '@dfai/domain';
import {
  applyProjectBackfill,
  previewProjectBackfill,
  undoProjectBackfill,
  type ActivityRecorder,
  type ArchivePorts,
  type ProjectBackfillRun,
} from '@dfai/application';
import type { MeetingProjectRow, MeetingProjectsProps } from '@dfai/ui';
import { localToday } from '../today.ts';
import { keepIfSame } from '../same-reading.ts';

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Filing the meetings that have no project (#227), offered on the Inbox page:
 * what each meeting's series says is read while the page shows, the sure
 * ones ticked, and nothing is written until the person files them. The run
 * is said in Activity, with each meeting left as it was and why, and can be
 * undone from the offer until it is dismissed or the vault is closed.
 */
export function useMeetingProjects({
  ports,
  vaultKey,
  indexReady,
  open,
  owner,
  activity,
  onChanged,
}: {
  ports: ArchivePorts;
  vaultKey: string | null;
  indexReady: boolean;
  /** Whether the Inbox page is showing: the meetings are read ahead once the index is ready, then again as it opens (#130). */
  open: boolean;
  /** The vault's owner, left out of who was at each meeting. */
  owner: { readonly selfName: string | null; readonly selfEmails: readonly string[] };
  activity: ActivityRecorder;
  /** After filing wrote meetings, so the tree and the index are read again. */
  onChanged: () => void;
}): MeetingProjectsProps | null {
  const [rows, setRows] = useState<readonly ProjectBackfillRow[] | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
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
  const [lastRun, setLastRun] = useState<ProjectBackfillRun | null>(null);
  const [revision, setRevision] = useState(0);
  // `busy` reaches the panel a render late; a double click would file twice.
  const running = useRef(false);
  // The rows the last preview showed: a row read again keeps the tick the person left it with.
  const shown = useRef<ReadonlySet<string>>(new Set());
  // Read as each preview starts; the addresses are compared by what they say, not by the list's identity.
  const latestOwner = useRef(owner);
  latestOwner.current = owner;
  const ownerKey = `${owner.selfName ?? ''}\n${owner.selfEmails.join('\n')}`;

  useEffect(() => {
    setRows(null);
    shown.current = new Set();
    setExpanded(false);
    setDismissed(false);
    setResult(null);
    setProblem(null);
    setLastRun(null);
  }, [vaultKey]);

  useEffect(() => {
    if (!indexReady || vaultKey === null || dismissed) return;
    if (!open && prefetched.current === vaultKey) return;
    let cancelled = false;
    previewProjectBackfill({ ports, owner: latestOwner.current })
      .then((read) => {
        if (cancelled) return;
        setRows((was) => keepIfSame(was, read.length === 0 ? null : read));
        const before = shown.current;
        shown.current = new Set(read.map(rowKey));
        setChosen((ticked) => keepIfSame(ticked, ticksAfterPreview({ read, ticked, before })));
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setProblem(`Meetings with no project could not be read: ${reasonOf(cause)}`);
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      });
    return () => {
      cancelled = true;
    };
  }, [ports, open, indexReady, vaultKey, dismissed, ownerKey, revision]);

  const settle = useCallback(
    (work: () => Promise<string>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setProblem(null);
      work()
        .then((said) => {
          setResult(said);
          setExpanded(false);
        })
        .catch((cause: unknown) => {
          const message = `Filing meetings under their projects failed: ${reasonOf(cause)}`;
          setProblem(message);
          activity.record({ level: 'error', kind: 'meeting', message, subject: null });
        })
        .finally(() => {
          running.current = false;
          setBusy(false);
          setRevision((at) => at + 1);
          onChanged();
        });
    },
    [activity, onChanged],
  );

  const run = useCallback(() => {
    if (rows === null) return;
    const filing = rows.filter((row) => chosen.has(row.meeting));
    settle(async () => {
      const done = await applyProjectBackfill({ ports, rows: filing, today: localToday() });
      setLastRun(done);
      const said = projectBackfillLine({ filed: done.done.length, left: done.left.length });
      report(activity, said, done);
      return said;
    });
  }, [rows, chosen, ports, activity, settle]);

  const undo = useCallback(() => {
    if (lastRun === null) return;
    settle(async () => {
      const undone = await undoProjectBackfill({ ports, run: lastRun, today: localToday() });
      setLastRun(null);
      const said = projectBackfillUndoLine({
        restored: undone.done.length,
        left: undone.left.length,
      });
      report(activity, said, undone);
      return said;
    });
  }, [lastRun, ports, activity, settle]);

  const reading = open && vaultKey !== null && !dismissed && previewedFor !== vaultKey;
  const waitingForIndex = reading && !indexReady;
  if (!reading && rows === null && result === null && problem === null && lastRun === null)
    return null;
  return {
    reading,
    waitingForIndex,
    rows: dismissed || rows === null ? null : rows.map((row) => rowOf(row, chosen)),
    open: expanded,
    busy,
    result,
    problem,
    canUndo: lastRun !== null && lastRun.done.length > 0,
    onOpen: () => setExpanded(true),
    onToggle: (path) => setChosen((now) => toggled(now, path)),
    onRun: run,
    onUndo: undo,
    onClose: () => {
      if (expanded) setExpanded(false);
      else setDismissed(true);
    },
    onDismiss: () => {
      setResult(null);
      setLastRun(null);
    },
  };
}

/** A row as the person ticked it: its meeting and the project suggested for it. */
const rowKey = (row: ProjectBackfillRow) => `${row.meeting}\n${row.suggestion?.project ?? ''}`;

/**
 * What is ticked once a preview is read again — after a run, or as the page
 * comes back: a row shown before keeps the tick the person left it with; a
 * new row, or one whose suggested project changed, is ticked only when sure.
 */
function ticksAfterPreview({
  read,
  ticked,
  before,
}: {
  read: readonly ProjectBackfillRow[];
  ticked: ReadonlySet<string>;
  before: ReadonlySet<string>;
}): ReadonlySet<string> {
  const chosen = read.filter((row) =>
    before.has(rowKey(row)) ? ticked.has(row.meeting) : isFiledByDefault(row),
  );
  return new Set(chosen.map((row) => row.meeting));
}

function rowOf(row: ProjectBackfillRow, chosen: ReadonlySet<string>): MeetingProjectRow {
  return {
    path: row.meeting,
    meeting: `${row.date} ${row.title}`,
    project: row.suggestion?.title ?? null,
    confidence: row.suggestion?.confidence ?? null,
    reason: row.suggestion?.reason ?? NO_SERIES_PROJECT,
    chosen: chosen.has(row.meeting),
  };
}

function toggled(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** The run in Activity: one line for it, and one per meeting it left. */
function report(activity: ActivityRecorder, said: string, run: ProjectBackfillRun): void {
  activity.record({ level: 'info', kind: 'meeting', message: said, subject: null });
  for (const { path, reason } of run.left) {
    activity.record({
      level: 'warning',
      kind: 'meeting',
      message: `Filing meetings left ${noteTitle(path)} as it was: ${reason}`,
      subject: { kind: 'note', path },
    });
  }
}
