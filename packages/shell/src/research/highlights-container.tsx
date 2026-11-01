import { localClock } from '../today.ts';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { highlightsScreen } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';

const HighlightsScreen = highlightsScreen.Component;

/**
 * All highlights as a tab (#507): it reads the highlights itself, through the
 * index; a row opens its note at the highlight's block.
 */
export function HighlightsContainer({ wiring, chrome }: PageContainerProps) {
  const { pages, pane } = wiring;
  return (
    <LoadedLater chrome={chrome}>
      <HighlightsScreen
        index={pane.index}
        vault={pane.vault}
        ready={pages.indexReady}
        notePaths={pane.notePaths}
        now={localClock.now}
        onOpen={pages.openBlock}
        {...chrome}
      />
    </LoadedLater>
  );
}
