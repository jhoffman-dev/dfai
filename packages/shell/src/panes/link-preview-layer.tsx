import { memo } from 'react';
import { createVaultPath, noteTitle, resolveWikiLinkTarget } from '@dfai/domain';
import {
  LinkPreviewCard,
  previewPlacement,
  useHoveredLink,
  type HoveredLink,
  type HoveredLinkStore,
} from '@dfai/ui';
import { useWorkspaceWiring } from '../workspace/workspace-wiring.tsx';
import { useLinkPreview } from './use-link-preview.ts';

/**
 * The preview card for the link the pointer rests on (slice 6b, Q22): a
 * wikilink or a relation value in the panes or the peek. Drawn as a card
 * comes and goes and for nothing else — what holds the links is not drawn
 * for it — and reads the window's wiring only while a card is up.
 */
export const LinkPreviewLayer = memo(function LinkPreviewLayer({
  store,
}: {
  store: HoveredLinkStore;
}) {
  const hovered = useHoveredLink(store);
  return hovered === null ? null : <HoveredLinkCard hovered={hovered} />;
});

/** The card for one link: the note it opens, read from its file; nothing for a link to no note. */
function HoveredLinkCard({ hovered }: { hovered: HoveredLink }) {
  const { pane } = useWorkspaceWiring();
  const { target } = hovered;
  const path =
    target.kind === 'note' ? target.path : resolveWikiLinkTarget(target.link, pane.notePaths);
  const read = useLinkPreview({ ports: pane.notes, types: pane.types, vault: pane.vault, path });
  if (path === null) return null;
  return (
    <LinkPreviewCard
      // The title is known before the file is read; the rest follows it.
      preview={read ?? { title: noteTitle(createVaultPath(path)), kicker: null, excerpt: null }}
      placement={previewPlacement(hovered.anchor, {
        width: window.innerWidth,
        height: window.innerHeight,
      })}
    />
  );
}
