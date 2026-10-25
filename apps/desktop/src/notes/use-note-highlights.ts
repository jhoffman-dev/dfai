import { useCallback, useMemo, useRef } from 'react';
import {
  createHighlightReadMemo,
  editHighlightComment,
  literatureHighlightReader,
  removeHighlight as removeHighlightFrom,
  type MarkdownPort,
  type OpenNote,
  type OpenNotes,
  type VaultFsPort,
} from '@dfai/application';
import { noteTitle, type StrandedComment, type VaultPath } from '@dfai/domain';
import type { NoteHighlights } from '@dfai/ui';
import type { Toasts } from '../toasts/toasts.ts';
import { errorMessage } from '../query/error-message.ts';

/**
 * A literature note's highlights as its pane draws them (#523): each quote
 * block that is a highlight shown as its quote and comment, and a comment
 * typed in place written by `editHighlightComment` — the literature note's
 * own write, byte-preserving, `%%`-escaped and read back before it lands.
 * The pane's typing is written first, as Make task does, so the comment is
 * written over the note as it is on screen; typing that comes in meanwhile
 * has the write refused, and the field says so. Null for any other note.
 */
export function useNoteHighlights({
  fs,
  markdown,
  openNotes,
  flush,
  path,
  open,
  onChanged,
  toasts,
  onWritePending,
  kept,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  openNotes: OpenNotes;
  /** Writes the pane's unsaved typing, settling once it has landed or been refused. */
  flush: () => Promise<void>;
  path: VaultPath | null;
  open: OpenNote | null;
  /** Re-reads the tree and the index, after a comment was written. */
  onChanged: () => void;
  /** Where words that could not be written as the pane closed are told of. */
  toasts?: Pick<Toasts, 'show'>;
  /** Handed the editor's write of the comments typed and not yet written, for the pane's own flush. */
  onWritePending?: NoteHighlights['onWritePending'];
  /** Where comments the closing note could not write are kept, and offered back from, in the pane's vault. */
  kept?: KeptCommentsOfVault;
}): NoteHighlights | null {
  // Kept across readings of the note: its ids are built again only when its highlights change.
  const memo = useMemo(createHighlightReadMemo, [markdown, path]);
  const viewOf = useMemo(
    () =>
      open === null
        ? null
        : literatureHighlightReader(
            markdown,
            { properties: open.properties, text: open.onDisk },
            memo,
          ),
    [markdown, open, memo],
  );
  const editComment = useCallback(
    async ({ id, comment, base }: { id: string; comment: string; base: string }) => {
      if (path === null) throw new Error('No note is open to write the comment to.');
      await flush();
      await editHighlightComment({ fs, markdown, openNotes }, { path, id, comment, base });
      onChanged();
    },
    [fs, markdown, openNotes, flush, path, onChanged],
  );
  // A block's Delete on a highlight (#569): the note's own write, which leaves a Kindle
  // highlight's tombstone, after the pane's typing, as a comment is written. Each
  // write reads the note as the one before it left it: two deletes in quick
  // succession are both the person's word, and a write over a note another write
  // is changing would be refused by the host, so they are taken one after another.
  const removesQueued = useRef<Promise<void>>(Promise.resolve());
  const removeHighlight = useCallback(
    (id: string) => {
      if (path === null) return;
      const remove = async () => {
        await flush();
        await removeHighlightFrom({ fs, markdown, openNotes }, { path, id });
        onChanged();
      };
      // The pane always has its toasts; a host without them (a test) hears of nothing.
      // A failure is told of here, and the queue goes on to the next delete.
      removesQueued.current = removesQueued.current.then(remove).catch((error: unknown) => {
        toasts?.show({
          message: `The highlight could not be deleted: ${errorMessage(error)}`,
          tone: 'error',
        });
      });
    },
    [fs, markdown, openNotes, flush, path, onChanged, toasts],
  );
  const recovered = useMemo(
    () => (path === null || kept === undefined ? undefined : kept.offered(path)),
    [path, kept],
  );
  const onUnwrittenComments = useMemo(
    () =>
      path === null || (toasts === undefined && kept === undefined)
        ? undefined
        : (lost: readonly LostComment[]) => {
            keepOrSettle({ kept, path, lost, offered: recovered ?? [] });
            for (const each of lost) {
              toasts?.show({
                message: `Your comment on a highlight in “${noteTitle(path)}” was not saved: ${each.why}${kept === undefined ? '' : ' It is kept: open the note again to get it back.'} It read: “${each.comment}”`,
                tone: 'error',
                action: {
                  label: 'Copy',
                  onClick: () => void navigator.clipboard.writeText(each.comment),
                },
              });
            }
          },
    [path, toasts, kept, recovered],
  );
  return useMemo(
    () =>
      viewOf === null
        ? null
        : {
            viewOf,
            editComment,
            removeHighlight,
            ...(onUnwrittenComments !== undefined && { onUnwrittenComments }),
            ...(onWritePending !== undefined && { onWritePending }),
            ...(recovered !== undefined && recovered.length > 0 && { recovered }),
          },
    [viewOf, editComment, removeHighlight, onUnwrittenComments, onWritePending, recovered],
  );
}

/** A comment the closing note could not write, with the comment it was typed over and why. */
type LostComment = StrandedComment & { readonly why: string };

/** The pane's vault's kept comments (#534), as a note's highlights keep and take them. */
export interface KeptCommentsOfVault {
  readonly offered: (path: VaultPath) => readonly StrandedComment[];
  readonly keep: (kept: {
    path: VaultPath;
    comments: readonly StrandedComment[];
    reason: string;
  }) => void;
  /** Lets go of `comments`, the ones `offered` handed this note's fields, once they are written. */
  readonly settle: (settled: { path: VaultPath; comments: readonly StrandedComment[] }) => void;
}

/**
 * Keeps what the closing note could not write; lets go of what its fields were
 * offered once all is written. Comments kept after its fields were drawn never
 * reached them, so are not this note's to let go of.
 */
function keepOrSettle({
  kept,
  path,
  lost,
  offered,
}: {
  kept: KeptCommentsOfVault | undefined;
  path: VaultPath;
  lost: readonly LostComment[];
  offered: readonly StrandedComment[];
}): void {
  if (kept === undefined) return;
  const first = lost[0];
  if (first === undefined) {
    if (offered.length > 0) kept.settle({ path, comments: offered });
    return;
  }
  kept.keep({
    path,
    comments: lost.map(({ id, comment, base }) => ({ id, comment, base })),
    reason: first.why,
  });
}
