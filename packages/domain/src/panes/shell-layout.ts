import { MAX_PANES } from './workspace.ts';

/**
 * How the window arranges the sidebar and the panes, by its width alone
 * (#658). One rule for every screen: an iPad held upright, a phone, a desktop
 * window dragged narrow. The components draw what it says and decide nothing.
 *
 * The widths are the brief's: the sidebar is 224px (`--sidebar-width`), and a
 * note is read on a 720px measure (page.css). The sidebar stays beside the
 * work only while a note still reads at its full measure next to it; under
 * that the sidebar becomes a drawer over the work and one pane shows, since
 * two of anything narrower than a note each is not a comparison. The desktop
 * window at the widths it is used at — 944px and up — is left exactly as it
 * was: the rule changes nothing above `COMPACT_BELOW`.
 */
export const SIDEBAR_WIDTH = 224;
/** The width a note's body is read at (page.css, editor.css). */
export const NOTE_MEASURE = 720;
/** Under this width the shell is compact: the sidebar a drawer, one pane shown. */
export const COMPACT_BELOW = SIDEBAR_WIDTH + NOTE_MEASURE;

export interface ShellLayout {
  /** Beside the work, in the flow — or a drawer over it, opened on demand. */
  readonly sidebar: 'beside' | 'drawer';
  /** How many panes the width has room for. The window may hold more; only this many show. */
  readonly panes: number;
}

// The two answers as constants, so a width that crosses no breakpoint hands
// back the same object and nothing subscribed to it draws again.
const WIDE: ShellLayout = Object.freeze({ sidebar: 'beside', panes: MAX_PANES });
const COMPACT: ShellLayout = Object.freeze({ sidebar: 'drawer', panes: 1 });

/** The arrangement for a window `width` CSS pixels wide. */
export function shellLayoutFor(width: number): ShellLayout {
  return width < COMPACT_BELOW ? COMPACT : WIDE;
}
