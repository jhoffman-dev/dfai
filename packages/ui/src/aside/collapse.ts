import { SIDEBAR_WIDTH } from '@dfai/domain';

/**
 * How a narrow window folds the shell (brief §4): the right sidebar collapses
 * first, then the left. The widths are the brief's — 224px sidebar, 300px
 * aside (`--aside-width`), 340px for the type editor — plus the least the
 * work in between can live with.
 *
 * That least is set by the window itself: it is never narrower than 720px
 * (tauri.conf.json), and e2e/shell.attack-332.spec.ts holds every bar tidy
 * there with the sidebar open, so 720 − 224 is the work's floor. Which is why
 * the left sidebar never folds by width: the window cannot get narrower than
 * what the sidebar fits in, so "then the left" has no width to fire at. Only
 * the aside collapses, and this is the one rule for when.
 *
 * shell.css draws it as media queries, one pair per aside width;
 * collapse.test.ts holds them to the same numbers. Slice 8b reads this to
 * know what the window is showing (the toggle's pressed state, where the
 * focus may go) without measuring.
 *
 * Under 944px none of this applies: the sidebar is a drawer over the work,
 * not beside it (`shellLayoutFor`, the domain), and the app asks these with
 * `sidebarOpen: false`. The sidebar's width is the domain's constant, held
 * here under the name this file always had.
 */
export { SIDEBAR_WIDTH };
export const ASIDE_WIDTH = 300;
/** The type editor's aside (`.aside--type`, slice 12). */
export const ASIDE_WIDTH_TYPE = 340;
/** The window's own minimum width, which the left sidebar is sized to fit in. */
export const WINDOW_MIN_WIDTH = 720;
export const LEAST_WORK_WIDTH = WINDOW_MIN_WIDTH - SIDEBAR_WIDTH;

/** Under this width an aside of `asideWidth` collapses. */
export function asideCollapsesBelow({
  sidebarOpen,
  asideWidth = ASIDE_WIDTH,
}: {
  sidebarOpen: boolean;
  asideWidth?: number;
}): number {
  return (sidebarOpen ? SIDEBAR_WIDTH : 0) + asideWidth + LEAST_WORK_WIDTH;
}

/** Under this width the 300px aside collapses, while the left sidebar is open. */
export const ASIDE_COLLAPSES_BELOW = asideCollapsesBelow({ sidebarOpen: true });
/** Under this width the 300px aside collapses even with the left sidebar hidden by hand. */
export const ASIDE_COLLAPSES_BELOW_ALONE = asideCollapsesBelow({ sidebarOpen: false });

export function collapseFor({
  width,
  sidebarOpen,
  asideWidth = ASIDE_WIDTH,
}: {
  width: number;
  /** Whether the left sidebar is open, by the user's choice. */
  sidebarOpen: boolean;
  /** The aside's width: 300, or 340 for the type editor. */
  asideWidth?: number;
}): { aside: boolean } {
  return { aside: width < asideCollapsesBelow({ sidebarOpen, asideWidth }) };
}
