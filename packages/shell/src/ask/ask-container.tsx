import { LoadedLater } from '../page-frame-fallback.tsx';
import { askScreen } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useAskSeat } from './ask-seat.tsx';

const AskScreen = askScreen.Component;

/** Ask as a tab (#37): the chat the app hands it, and the vault its chats are kept in. */
export function AskContainer({ wiring, chrome, pane }: PageContainerProps & { pane: number }) {
  const seat = useAskSeat();
  // Outside the app's panes there is no chat to draw: a test's lone tab, say.
  if (seat === null) return null;
  return (
    <LoadedLater chrome={chrome}>
      <AskScreen
        seat={seat}
        fs={wiring.pages.ports.fs}
        vault={wiring.pane.vault}
        pane={pane}
        {...chrome}
      />
    </LoadedLater>
  );
}
