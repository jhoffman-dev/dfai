import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { noteTitle, paraMigrationLine } from '@dfai/domain';
import {
  hasParaMigrationWork,
  previewParaMigration,
  runParaMigration,
  type ActivityRecorder,
  type ArchivePorts,
  type ParaMigrationPreview,
} from '@dfai/application';
import type { ParaMigrationProps } from '@dfai/ui';
import { keepIfSame } from '../same-reading.ts';

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Moving the vault's Area and Resource notes onto the one Project type (#213),
 * from the Inbox page: what the move would do is read while the page shows,
 * and nothing is written until the person runs it from the preview. A run is
 * said in Activity, with every note left as it was and why. "Not now" puts
 * the offer away until the vault is opened again.
 */
export function useParaMigration({
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
  /** Whether the Inbox page is showing: the notes are read ahead once the index is ready, then again as it opens (#130). */
  open: boolean;
  activity: ActivityRecorder;
  /** After the move wrote files, so the types, tree and index are read again. */
  onChanged: () => void;
}): ParaMigrationProps | null {
  const [preview, setPreview] = useState<ParaMigrationPreview | null>(null);
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
    () => ({ fs: ports.fs, markdown: ports.markdown, index: ports.index }),
    [ports.fs, ports.markdown, ports.index],
  );

  useEffect(() => {
    setPreview(null);
    setExpanded(false);
    setDismissed(false);
    setResult(null);
    setProblem(null);
  }, [vaultKey]);

  useEffect(() => {
    if (!indexReady || vaultKey === null) return;
    if (!open && prefetched.current === vaultKey) return;
    let cancelled = false;
    previewParaMigration(migrationPorts)
      .then((read) => {
        if (cancelled) return;
        const now = hasParaMigrationWork(read) ? read : null;
        setPreview((was) => keepIfSame(was, now));
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setProblem(`Your PARA notes could not be read: ${reasonOf(cause)}`);
        setPreviewedFor(vaultKey);
        prefetched.current = vaultKey;
      });
    return () => {
      cancelled = true;
    };
  }, [migrationPorts, open, indexReady, vaultKey, revision]);

  const run = useCallback(() => {
    if (preview === null || running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    runParaMigration({ ports: migrationPorts, panes: ports.editors, preview })
      .then(({ written, left }) => {
        const said = paraMigrationLine({ moved: written.length, left: left.length });
        activity.record({ level: 'info', kind: 'app', message: said, subject: null });
        for (const { path, reason } of left) {
          activity.record({
            level: 'warning',
            kind: 'app',
            message: `Moving notes onto the Project type left ${noteTitle(path)} as it was: ${reason}`,
            subject: { kind: 'note', path },
          });
        }
        setResult(said);
        setExpanded(false);
      })
      .catch((cause: unknown) => {
        const message = `The notes could not be moved onto the Project type: ${reasonOf(cause)}`;
        setProblem(message);
        activity.record({ level: 'error', kind: 'app', message, subject: null });
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
        setRevision((at) => at + 1);
        onChanged();
      });
  }, [preview, migrationPorts, ports.editors, activity, onChanged]);

  const reading = open && vaultKey !== null && previewedFor !== vaultKey;
  const waitingForIndex = reading && !indexReady;
  if (!reading && preview === null && result === null && problem === null) return null;
  return {
    reading,
    waitingForIndex,
    preview: dismissed || preview === null ? null : preview,
    open: expanded,
    busy,
    result,
    problem,
    onOpen: () => setExpanded(true),
    onRun: run,
    onClose: () => {
      if (expanded) setExpanded(false);
      else setDismissed(true);
    },
    onDismiss: () => setResult(null),
  };
}
