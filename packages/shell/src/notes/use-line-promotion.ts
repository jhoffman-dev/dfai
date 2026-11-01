import { useCallback, useMemo, useState } from 'react';
import { noteTitle, taskTypeOf, type ObjectType, type VaultPath } from '@dfai/domain';
import {
  promoteChecklistLine,
  PromotionRefused,
  TaskRuleRefusedError,
  undoPromotion,
  UnsavedTypingError,
  type ActivityLog,
  type MarkdownPort,
  type OpenNotes,
  type Promotion,
  type VaultFsPort,
} from '@dfai/application';
import type { LinePromotion, PromotedLine } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import type { Toasts } from '../toasts/toasts.ts';
import { errorMessage } from '../query/error-message.ts';
import { cryptoRng } from '../random.ts';
import { localToday } from '../today.ts';

/**
 * What Make task and its Undo refuse so as not to lose or double anything —
 * shown on the page for the person to act on, and no fault to record.
 */
const PROMOTION_REFUSALS = [PromotionRefused, TaskRuleRefusedError, UnsavedTypingError];

/**
 * Making a checklist line of the note in a pane a task (P30-03). The pane's
 * typing is written first, so the line is promoted as it is on screen; then
 * the task is made and the line rewritten in one use-case, and the window's
 * toast says what was made (UI v2, slice 15), with Open and one Undo that
 * takes back both — a byte-preserving write, refused once either moved on,
 * and nothing once another vault has opened; a refused Undo is a warning
 * toast. A line that could not become a task is said on the page until
 * dismissed; one it gives up on is also recorded in the Activity log.
 */
export function useLinePromotion({
  fs,
  markdown,
  openNotes,
  flush,
  path,
  notePaths,
  types,
  onChanged,
  onOpenNote,
  activity,
  toasts,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  openNotes: OpenNotes;
  /** Writes the pane's unsaved typing, settling once it has landed or been refused. */
  flush: () => Promise<void>;
  path: VaultPath | null;
  notePaths: readonly VaultPath[];
  types: readonly ObjectType[];
  /** Re-reads the tree and the index, after the promotion wrote. */
  onChanged: () => void;
  onOpenNote: (path: VaultPath) => void;
  activity: Pick<ActivityLog, 'inOpenVault'>;
  toasts: Pick<Toasts, 'show' | 'vaultNow'>;
}): LinePromotion | undefined {
  // Kept with the note it is about, so what was said of one is not shown over another.
  const [said, setSaid] = useState<{ path: VaultPath; message: string } | null>(null);
  const dismiss = useCallback(() => setSaid(null), []);
  const taskType = useMemo(() => taskTypeOf(types), [types]);

  /**
   * Takes a promotion back, from its toast. What stops it is said in the
   * window's toasts too — where the person is, whether or not the pane that
   * made the task is still up or still shows its note: refused as a warning,
   * failed as an error, and either kept in Activity by the toasts, once.
   */
  const undo = useCallback(
    async (promotion: Promotion) => {
      try {
        await undoPromotion({ fs, openNotes, promotion });
        onChanged();
      } catch (error) {
        const refused = PROMOTION_REFUSALS.some((refusal) => error instanceof refusal);
        toasts.show({ message: errorMessage(error), tone: refused ? 'warning' : 'error' });
      }
    },
    [fs, openNotes, onChanged, toasts],
  );

  const promote = useCallback(
    async (source: VaultPath, line: PromotedLine) => {
      const named = { activity, write: 'task', path: source, refusal: PROMOTION_REFUSALS } as const;
      // The vault it is asked in: one opened before the task lands gets none of it.
      const madeIn = toasts.vaultNow();
      try {
        await flush();
        const promotion = await withGiveUpRecorded(named, () =>
          promoteChecklistLine({
            fs,
            markdown,
            openNotes,
            rng: cryptoRng,
            today: localToday(),
            notePaths,
            taskType,
            choice: { source, line: line.index, text: line.text },
          }),
        );
        if (toasts.vaultNow() !== madeIn) return;
        onChanged();
        setSaid(null);
        toasts.show({
          message: `“${noteTitle(promotion.task)}” is a task now.`,
          tone: 'change',
          onUndo: () => {
            // Pressed once another vault has opened, its paths are not that vault's: it writes nothing.
            if (toasts.vaultNow() === madeIn) void undo(promotion);
          },
          action: { label: 'Open', onClick: () => onOpenNote(promotion.task) },
        });
      } catch (error) {
        if (toasts.vaultNow() === madeIn) setSaid({ path: source, message: errorMessage(error) });
      }
    },
    [
      fs,
      markdown,
      openNotes,
      flush,
      notePaths,
      taskType,
      onChanged,
      activity,
      toasts,
      undo,
      onOpenNote,
    ],
  );

  const message = path !== null && said?.path === path ? said.message : null;
  const notice = useMemo(
    () => (message === null ? null : { message, onDismiss: dismiss }),
    [message, dismiss],
  );
  return useMemo(() => {
    if (path === null) return undefined;
    return { promote: (line: PromotedLine) => void promote(path, line), notice };
  }, [path, promote, notice]);
}
