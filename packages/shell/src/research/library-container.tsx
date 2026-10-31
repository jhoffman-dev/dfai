import { LoadedLater } from '../page-frame-fallback.tsx';
import { libraryScreen } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';

const LibraryScreen = libraryScreen.Component;

/** The Library as a tab (#507): it reads the literature notes itself, through the index. */
export function LibraryContainer({ wiring, chrome }: PageContainerProps) {
  const { pages, pane } = wiring;
  return (
    <LoadedLater chrome={chrome}>
      <LibraryScreen
        index={pane.index}
        vault={pane.vault}
        ready={pages.indexReady}
        fs={pages.ports.fs}
        onOpen={pages.openNote}
        {...chrome}
      />
    </LoadedLater>
  );
}
