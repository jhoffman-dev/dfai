import { memo } from 'react';
import type { TabId, VaultPath } from '@dfai/domain';
import { PeekDialog, SaveStatus, useLinkHover, type OpenHow } from '@dfai/ui';
import { closePeek, openPeek, replacePeek, stepPeek, usePeek } from '../overlay-store.ts';
import { leavePeek, leavingPeek, useHoldersFlushed } from './peek-moves.ts';
import { peekPosition, type Peek } from '../overlay.ts';
import { clickLink, openNote } from '../workspace/open-place.ts';
import { workspaceNow } from '../workspace/workspace-store.ts';
import { useWorkspaceStores, useWorkspaceWiring } from '../workspace/workspace-wiring.tsx';
import { LinkPreviewLayer } from './link-preview-layer.tsx';
import { useNotePane } from './note-pane-container.tsx';

/**
 * The id the peek's editor is registered under among the tabs' editors, so
 * a save in it re-reads a pane holding the same note and a write from
 * elsewhere reaches it (`OpenEditors`). Never a tab's: theirs are `t<n>`.
 */
export const PEEK_EDITOR: TabId = 'peek';

/**
 * The center peek over the panes (slice 6b), drawn while one is up. It
 * subscribes to the peek alone: a row clicked, a step, Esc — nothing else in
 * the window is drawn for them, the table under it included.
 */
export const PeekLayer = memo(function PeekLayer() {
  const { overlays } = useWorkspaceStores();
  const peek = usePeek(overlays);
  return peek === null ? null : <PeekContainer peek={peek} />;
});

/**
 * The peek with its note: the page's own editor stack (`useNotePane`, with
 * `chrome="peek"`), its autosave and stranded-edit rules, registered as one
 * more editor on the note. Its links preview, and a plain click on one shows
 * that note here instead; expand, new tab and split write what was typed,
 * then open the note and close the peek.
 */
function PeekContainer({ peek }: { peek: Peek }) {
  const wiring = useWorkspaceWiring();
  const { store, overlays, reveals, note, pane: context } = wiring;
  const { watch, store: hovered } = useLinkHover();
  const focused = () => workspaceNow(store).focused;
  const ready = useHoldersFlushed(context.editors, peek.path);
  // What was typed is on disk before anything else is shown, so what opens reads it.
  const leave = (act: () => void) => leavePeek(overlays, { flush: () => drawn.flush(), act });
  // The note is captured as the key is pressed: a step under way does not change what opens.
  const leaveFor = (path: VaultPath, how: OpenHow) => leave(() => openNote(store, path, how));
  const drawn = useNotePane({
    tabId: PEEK_EDITOR,
    // Read once no pane holds it with unsaved typing (`useHoldersFlushed`).
    path: ready ? peek.path : null,
    context,
    chrome: 'peek',
    aside: { store: wiring.aside, shown: wiring.shown, workspace: store },
    // A row of a view shown in the peek peeks in its place, from its own list.
    onPeek: (next) => openPeek(overlays, next),
    onOpenNote: (target, how = 'here') =>
      how === 'here' ? replacePeek(overlays, target) : leaveFor(target, how),
    onFollowLink: (target, heading, how) =>
      clickLink(
        {
          store,
          reveals,
          overlays,
          notePaths: context.notePaths,
          onProblem: context.onLinkProblem,
          places: context.linkPlaces,
          leavePeek: leave,
        },
        {
          pane: focused(),
          target,
          heading: heading ?? null,
          ...(how !== undefined && { how }),
          inPeek: true,
        },
      ),
    onRename: note.onRename,
    onToggleFavorite: note.onToggleFavorite,
    onMoveTo: note.onMoveTo,
    onDelete: note.onDelete,
    onMergeInto: note.onMergeInto,
    onShowInGraph: note.onShowInGraph,
    arrangement: {},
  });
  return (
    <PeekDialog
      title={drawn.title ?? 'Note'}
      position={peekPosition(peek)}
      status={<SaveStatus state={drawn.state} />}
      onStep={(index) => {
        if (!leavingPeek(overlays))
          stepPeek(overlays, index, (path) => listedOrUnknown(context.notePaths, path));
      }}
      onClose={() => closePeek(overlays)}
      onExpand={() => leaveFor(peek.path, 'here')}
      onOpenInNewTab={() => leaveFor(peek.path, 'new-tab')}
      onOpenInSplit={() => leaveFor(peek.path, 'split')}
      toastSlot={context.toasts.placeIn}
    >
      <div ref={watch}>{ready && drawn.page}</div>
      <LinkPreviewLayer store={hovered} />
    </PeekDialog>
  );
}

/** Whether a row's note is still in the vault's listing; any is, before the listing is in. */
function listedOrUnknown(notePaths: readonly VaultPath[], path: VaultPath): boolean {
  return notePaths.length === 0 || notePaths.includes(path);
}
