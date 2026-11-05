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
 *
 * Under `PHONE_BELOW` the screen is a phone's (#672): held in one hand, with
 * the thumb at the bottom. The drawer and the one pane stay, and a bar of
 * three screens is added along the bottom edge — quick add, Today, Notes —
 * so the day's three jobs need no drawer. The edge sits in the gap between
 * the widest phone held upright (about 480px) and the narrowest tablet held
 * upright (an iPad mini's 744px); nothing is made between them, so a phone
 * on its side (844px and up) is as wide as a tablet upright and is laid out
 * as one, with the drawer as the way about.
 */
export const SIDEBAR_WIDTH = 224;
/** The width a note's body is read at (page.css, editor.css). */
export const NOTE_MEASURE = 720;
/** Under this width the shell is compact: the sidebar a drawer, one pane shown. */
export const COMPACT_BELOW = SIDEBAR_WIDTH + NOTE_MEASURE;
/** Under this width the shell is a phone's: compact, with the bar of screens along the bottom. */
export const PHONE_BELOW = 600;

/** The screens a phone's bar offers, in the order they stand, left to right. */
export const PHONE_SCREENS = ['quick-add', 'today', 'notes'] as const;
export type PhoneScreen = (typeof PHONE_SCREENS)[number];

export interface ShellLayout {
  /** Beside the work, in the flow — or a drawer over it, opened on demand. */
  readonly sidebar: 'beside' | 'drawer';
  /** How many panes the width has room for. The window may hold more; only this many show. */
  readonly panes: number;
  /** The bar of screens along the bottom edge, on a phone; null where the sidebar is the way about. */
  readonly screens: readonly PhoneScreen[] | null;
}

// The three answers as constants, so a width that crosses no breakpoint hands
// back the same object and nothing subscribed to it draws again.
const WIDE: ShellLayout = Object.freeze({ sidebar: 'beside', panes: MAX_PANES, screens: null });
const COMPACT: ShellLayout = Object.freeze({ sidebar: 'drawer', panes: 1, screens: null });
const PHONE: ShellLayout = Object.freeze({ sidebar: 'drawer', panes: 1, screens: PHONE_SCREENS });

/** The arrangement for a window `width` CSS pixels wide. */
export function shellLayoutFor(width: number): ShellLayout {
  if (width < PHONE_BELOW) return PHONE;
  return width < COMPACT_BELOW ? COMPACT : WIDE;
}
