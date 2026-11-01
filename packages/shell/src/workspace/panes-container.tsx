import { memo } from 'react';
import { PaneFrame, PaneSplit, useLinkHover } from '@dfai/ui';
import { LinkPreviewLayer } from '../panes/link-preview-layer.tsx';
import { useFocusAfterArrange } from '../panes/use-focus-after-arrange.ts';
import { PaneContentContainer } from './pane-content-container.tsx';
import { TabStripContainer } from './tab-strip-container.tsx';
import { focusPane, useFocusedPane, usePaneKeys } from './workspace-store.ts';
import { useWorkspaceStores } from './workspace-wiring.tsx';

/**
 * The panes, one frame each, keyed by the pane's own key so the pane that is
 * left when the other closes keeps its editors (tab-model.md §3). Drawn again
 * for a pane coming or going and for the focus moving; a tab switch inside a
 * pane draws that pane's strip and content and nothing here. Their links
 * preview, listened for here once by delegation: a card coming and going
 * draws the card alone (slice 6b).
 */
export const PanesContainer = memo(function PanesContainer() {
  const { store } = useWorkspaceStores();
  const keys = usePaneKeys(store);
  const focused = useFocusedPane(store);
  useFocusAfterArrange(keys.length);
  const { watch, store: hovered } = useLinkHover();
  return (
    <div className="shell__links" ref={watch}>
      <PaneSplit count={keys.length}>
        {keys.map((key, pane) => (
          <PaneFrame
            key={key}
            label={`Pane ${pane + 1}`}
            focused={pane === focused}
            onFocus={() => focusPane(store, pane)}
          >
            <PaneContainer pane={pane} focused={pane === focused} />
          </PaneFrame>
        ))}
      </PaneSplit>
      <LinkPreviewLayer store={hovered} />
    </div>
  );
});

/** One pane: its strip over its content. Drawn again only for its own place or focus changing. */
const PaneContainer = memo(function PaneContainer({
  pane,
  focused,
}: {
  pane: number;
  focused: boolean;
}) {
  return (
    <>
      <TabStripContainer pane={pane} focused={focused} />
      <PaneContentContainer pane={pane} />
    </>
  );
});
