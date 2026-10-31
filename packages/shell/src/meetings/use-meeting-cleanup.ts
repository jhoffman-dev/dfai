import { useCallback, useEffect, useRef, useState } from 'react';
import { CLEANUP_REASON_WORDS, createVaultPath, noteTitle, type VaultPath } from '@dfai/domain';
import {
  applyMeetingCleanup,
  keepMeetingCleanupTasks,
  meetingCleanupNeedsOwner,
  previewMeetingCleanup,
  type ActivityRecorder,
  type ArchiveOutcome,
  type ArchivePorts,
  type CleanupOwner,
  type ListedCleanupTask,
  type MeetingCleanupPorts,
} from '@dfai/application';
import type { MeetingCleanupProps } from '@dfai/ui';
import { localToday } from '../today.ts';
import { keepIfSame } from '../same-reading.ts';

const tasks = (count: number) => (count === 1 ? '1 task' : `${count} tasks`);
const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** What the offer says when it cannot judge the tasks meetings made: it lists none, so nothing is ticked. */
export const NEEDS_OWNER_NOTICE =
  'DFAI can’t tell which tasks meetings made are yours, so it offers none to archive. Add your name or email in Settings → Profile.';

/**
 * The offered cleanup on the Inbox page (#226): the tasks the "After a
 * meeting" rule made that today's rules would not have, read while the page
 * shows, once the owner's name and addresses are known. Nothing moves until
 * the person presses Archive in the preview, and any task they untick stays.
 * A task they untick is marked kept, when they archive or say "Not now",
 * and is never listed again. While the vault does not say who its owner is,
 * nothing is listed, and the offer says why. The run is said in Activity,
 * with every task it left as it was and why. "Not now" puts the offer away
 * until the vault is opened again.
 */
export function useMeetingCleanup({
  ports,
  owner,
  vaultKey,
  indexReady,
  open,
  activity,
  onChanged,
  onOpenTask,
}: {
  ports: MeetingCleanupPorts & ArchivePorts;
  /** Null until the profile and the owner's addresses have been read: nothing is judged on a stand-in. */
  owner: CleanupOwner | null;
  vaultKey: string | null;
  indexReady: boolean;
  /** Whether the Inbox page is showing: the vault is read ahead once the index is ready, then again as it opens (#130). */
  open: boolean;
  activity: ActivityRecorder;
  /** After tasks were archived, so the tree and the index are read again. */
  onChanged: () => void;
  onOpenTask: (path: string) => void;
}): MeetingCleanupProps | null {
  const [listed, setListed] = useState<readonly ListedCleanupTask[] | null>(null);
  const [needsOwner, setNeedsOwner] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
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
  // `busy` reaches the panel a render late; a double click would archive twice.
  const running = useRef(false);

  useEffect(() => {
    setListed(null);
    setNeedsOwner(false);
    setKept(new Set());
    setExpanded(false);
    setDismissed(false);
    setResult(null);
    setProblem(null);
  }, [vaultKey]);

  useEffect(() => {
    if (!indexReady || vaultKey === null || owner === null || dismissed) return;
    if (!open && prefetched.current === vaultKey) return;
    let cancelled = false;
    previewMeetingCleanup({ ports, owner })
      .then(async (read) => {
        const unjudged = read.length === 0 && (await meetingCleanupNeedsOwner({ ports, owner }));
        if (cancelled) return;
        setListed((was) => keepIfSame(was, read));
        setNeedsOwner(unjudged);
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setProblem(`The tasks meetings made could not be read: ${reasonOf(cause)}`);
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      });
    return () => {
      cancelled = true;
    };
  }, [ports, owner, open, indexReady, vaultKey, dismissed, revision]);

  const apply = useCallback(() => {
    if (listed === null || owner === null || running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    applyMeetingCleanup({
      ports,
      owner,
      shown: listed,
      kept: [...kept].map((path) => createVaultPath(path)),
      today: localToday(),
    })
      .then((done) => {
        const left =
          done.failed.length === 0 ? '' : `, ${tasks(done.failed.length)} left as they were`;
        const said = `Archived ${tasks(done.moves.length)} meetings made that weren’t yours${left}.`;
        activity.record({ level: 'info', kind: 'automation', message: said, subject: null });
        recordLeft(activity, done.failed);
        setResult(said);
        setExpanded(false);
        setKept(new Set());
      })
      .catch((cause: unknown) => {
        const message = `The cleanup stopped: ${reasonOf(cause)}`;
        setProblem(message);
        activity.record({ level: 'error', kind: 'automation', message, subject: null });
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
        setRevision((at) => at + 1);
        onChanged();
      });
  }, [listed, owner, kept, ports, activity, onChanged]);

  const toggle = useCallback((path: string) => {
    setKept((now) => {
      const next = new Set(now);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const dismiss = useCallback(() => {
    const keeping = (listed ?? []).filter(({ path }) => kept.has(path)).map(({ path }) => path);
    if (keeping.length > 0) rememberKept({ ports, paths: keeping, activity });
    setDismissed(true);
    setExpanded(false);
    setResult(null);
    setProblem(null);
  }, [listed, kept, ports, activity]);

  const offered = !dismissed && listed !== null && listed.length > 0 ? listed : null;
  const notice = !dismissed && offered === null && needsOwner ? NEEDS_OWNER_NOTICE : null;
  const reading =
    open && vaultKey !== null && owner !== null && !dismissed && previewedFor !== vaultKey;
  const waitingForIndex = reading && !indexReady;
  if (!reading && offered === null && result === null && notice === null && problem === null)
    return null;
  return {
    reading,
    waitingForIndex,
    tasks:
      offered === null
        ? null
        : offered.map(({ path, title, because }) => ({
            path,
            title,
            why: CLEANUP_REASON_WORDS[because],
          })),
    kept,
    open: expanded,
    busy,
    result,
    notice,
    problem,
    onOpen: () => setExpanded(true),
    onToggle: toggle,
    onApply: apply,
    onClose: () => setExpanded(false),
    onDismiss: dismiss,
    onOpenTask,
  };
}

/** Every task the cleanup left as it was, and why, in Activity. */
function recordLeft(activity: ActivityRecorder, failed: ArchiveOutcome['failed']): void {
  for (const { path, reason } of failed) {
    activity.record({
      level: 'warning',
      kind: 'automation',
      message: `The cleanup left ${noteTitle(path)} as it was: ${reason}`,
      subject: { kind: 'note', path },
    });
  }
}

/** Marks the tasks the person unticked before "Not now", so they are not listed again. */
function rememberKept({
  ports,
  paths,
  activity,
}: {
  ports: ArchivePorts;
  paths: readonly string[];
  activity: ActivityRecorder;
}): void {
  const keeping: VaultPath[] = paths.map((path) => createVaultPath(path));
  keepMeetingCleanupTasks({ ports, paths: keeping })
    .then((failed) => recordLeft(activity, failed))
    .catch((cause: unknown) =>
      activity.record({
        level: 'error',
        kind: 'automation',
        message: `The tasks you kept could not be marked as kept: ${reasonOf(cause)}`,
        subject: null,
      }),
    );
}
