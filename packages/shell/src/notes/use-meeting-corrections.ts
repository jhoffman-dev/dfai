import { useCallback, useMemo, useState } from 'react';
import { recordedCorrections, type VaultPath } from '@dfai/domain';
import {
  CorrectionRefusedError,
  NoteChangedError,
  undoMeetingTermCorrections,
  UnsavedTypingError,
  type ActivityLog,
  type MarkdownPort,
  type OpenNotes,
  type VaultFsPort,
} from '@dfai/application';
import type { CorrectionsNotice } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { errorMessage } from '../query/error-message.ts';

/** What Undo corrections refuses rather than fails at: shown on the band, and no fault to record. */
const UNDO_REFUSALS = [CorrectionRefusedError, UnsavedTypingError, NoteChangedError];

/**
 * The corrections band of the meeting in a pane (P28-06): what the import
 * corrected, read from the note's frontmatter, and its Undo. The pane's
 * typing is written first, so a meeting edited since it was corrected is
 * refused as the file says, never as it was when the pane opened it.
 */
export function useMeetingCorrections({
  fs,
  markdown,
  openNotes,
  flush,
  path,
  properties,
  onChanged,
  activity,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  openNotes: Pick<OpenNotes, 'state' | 'reload'>;
  /** Writes the pane's unsaved typing, settling once it has landed or been refused. */
  flush: () => Promise<void>;
  path: VaultPath | null;
  /** The open note's frontmatter; null while none is open. */
  properties: Readonly<Record<string, unknown>> | null;
  /** Re-reads the tree and the index, after the undo wrote. */
  onChanged: () => void;
  activity: Pick<ActivityLog, 'inOpenVault'>;
}): CorrectionsNotice | undefined {
  // Kept with the note it is about, so a refusal is never shown over another.
  const [refusal, setRefusal] = useState<{
    path: VaultPath;
    reason: string;
    permanent: boolean;
  } | null>(null);
  const [undoing, setUndoing] = useState<VaultPath | null>(null);
  // Meetings whose band was dismissed this session; the record stays in the file.
  const [dismissed, setDismissed] = useState<ReadonlySet<VaultPath>>(new Set());

  const undo = useCallback(
    async (at: VaultPath) => {
      const named = { activity, write: 'corrections', path: at, refusal: UNDO_REFUSALS } as const;
      setUndoing(at);
      try {
        await flush();
        await withGiveUpRecorded(named, () =>
          undoMeetingTermCorrections({ ports: { fs, markdown, editors: openNotes }, path: at }),
        );
        setRefusal(null);
        onChanged();
      } catch (error) {
        // Only a body that no longer matches the record stays refused: typing not
        // yet saved, or a note changed a moment ago, may well be fine on the next try.
        setRefusal({
          path: at,
          reason: errorMessage(error),
          permanent: error instanceof CorrectionRefusedError,
        });
      } finally {
        setUndoing(null);
      }
    },
    [fs, markdown, openNotes, flush, onChanged, activity],
  );

  const records = useMemo(
    () => (properties === null ? null : recordedCorrections(properties)),
    [properties],
  );
  if (path === null || records === null || dismissed.has(path)) return undefined;
  const refused = refusal?.path === path ? refusal : null;
  return {
    spellings: records.map(({ from, to, count }) => ({ from, to, count })),
    onUndo: () => void undo(path),
    refusal: refused?.reason ?? null,
    permanent: refused?.permanent ?? false,
    onDismiss: () => setDismissed((was) => new Set(was).add(path)),
    undoing: undoing === path,
  };
}
