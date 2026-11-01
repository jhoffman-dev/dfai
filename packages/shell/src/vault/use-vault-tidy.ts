import { useCallback, useEffect, useRef, useState } from 'react';
import { createVaultPath, noteTitle, type TidyPlan } from '@dfai/domain';
import {
  applyVaultTidy,
  previewVaultTidy,
  type ActivityRecorder,
  type ArchivePorts,
} from '@dfai/application';
import type { VaultTidyProps } from '@dfai/ui';
import { localToday } from '../today.ts';
import { keepIfSame } from '../same-reading.ts';

const notes = (count: number) => (count === 1 ? '1 note' : `${count} notes`);
const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The one-time tidy, offered on the Inbox page (#214): what it would move is
 * read while the page shows, and nothing moves until the person presses
 * Move in the preview. The run is said in Activity, with every note it left
 * where it was and why. "Not now" puts the offer away until the vault is
 * opened again; a vault with nothing to move is offered nothing.
 */
export function useVaultTidy({
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
  /** Whether the Inbox page is showing: read ahead from the index once it is ready, walked again as it opens (#130). */
  open: boolean;
  activity: ActivityRecorder;
  /** After the tidy moved notes, so the tree and the index are read again. */
  onChanged: () => void;
}): VaultTidyProps | null {
  const [plan, setPlan] = useState<TidyPlan | null>(null);
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
  // `busy` reaches the panel a render late; a double click would move twice.
  const running = useRef(false);

  useEffect(() => {
    setPlan(null);
    setExpanded(false);
    setDismissed(false);
    setResult(null);
    setProblem(null);
  }, [vaultKey]);

  useEffect(() => {
    if (!indexReady || vaultKey === null || dismissed) return;
    // Read ahead once per vault, not again on the index's news: by design, a note dropped in while the Inbox is shut lands as it opens, held still like any late arrival (#130).
    if (!open && prefetched.current === vaultKey) return;
    let cancelled = false;
    // Read ahead from the index's list of notes: walking the vault then would be
    // taken for a refresh after whatever it last reported (#254). As the Inbox
    // opens it walks, so what it shows is the disk's; the same plan costs nothing.
    const ahead = !open;
    const known = ahead
      ? ports.index.manifest().then((entries) => entries.map(({ path }) => createVaultPath(path)))
      : Promise.resolve(undefined);
    known
      .then((notePaths) =>
        // An index that lists nothing has nothing to go on: left for the open's walk.
        ahead && notePaths?.length === 0 ? null : previewVaultTidy(ports, localToday(), notePaths),
      )
      .then((read) => {
        if (cancelled || read === null) return;
        setPlan((was) => keepIfSame(was, read));
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setProblem(`The vault could not be read for a tidy: ${reasonOf(cause)}`);
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      });
    return () => {
      cancelled = true;
    };
  }, [ports, open, indexReady, vaultKey, dismissed, revision]);

  const apply = useCallback(() => {
    if (plan === null || running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    applyVaultTidy({ ports, shown: plan, today: localToday() })
      .then((done) => {
        const left =
          done.failed.length === 0 ? '' : `, ${notes(done.failed.length)} left as they were`;
        const said = `Tidied the vault: moved ${notes(done.moved.length)} to their home folders${left}.`;
        activity.record({ level: 'info', kind: 'app', message: said, subject: null });
        for (const { path, reason } of done.failed) {
          activity.record({
            level: 'warning',
            kind: 'app',
            message: `The tidy left ${noteTitle(path)} as it was: ${reason}`,
            subject: { kind: 'note', path },
          });
        }
        setResult(said);
        setExpanded(false);
      })
      .catch((cause: unknown) => {
        const message = `The tidy stopped: ${reasonOf(cause)}`;
        setProblem(message);
        activity.record({ level: 'error', kind: 'app', message, subject: null });
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
        setRevision((at) => at + 1);
        onChanged();
      });
  }, [plan, ports, activity, onChanged]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setExpanded(false);
    setResult(null);
    setProblem(null);
  }, []);

  const offered = !dismissed && plan !== null && plan.moves.length > 0 ? plan : null;
  const reading = open && vaultKey !== null && !dismissed && previewedFor !== vaultKey;
  const waitingForIndex = reading && !indexReady;
  if (!reading && offered === null && result === null && problem === null) return null;
  return {
    reading,
    waitingForIndex,
    preview: offered === null ? null : { moves: offered.moves, refused: offered.refused },
    open: expanded,
    busy,
    result,
    problem,
    onOpen: () => setExpanded(true),
    onApply: apply,
    onClose: () => setExpanded(false),
    onDismiss: dismiss,
  };
}
