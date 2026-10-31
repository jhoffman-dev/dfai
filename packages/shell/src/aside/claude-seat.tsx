import { createContext, useContext, type ReactNode } from 'react';

const ClaudeSeatContext = createContext<ReactNode>(null);

/**
 * The chat, handed to the aside's Claude tab (UI v2 plan, question 4) as a
 * context rather than a prop: the chat's state is the window's and changes
 * with every turn, and only the Claude tab should be drawn for it — not the
 * aside around it, nor the Properties it is not showing.
 */
export const ClaudeSeatProvider = ClaudeSeatContext.Provider;

/** The Claude tab's content: the chat as the app hands it over. */
export function ClaudeSeat() {
  return useContext(ClaudeSeatContext);
}
