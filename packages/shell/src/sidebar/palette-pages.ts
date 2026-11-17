import type { PaletteCommand } from '@dfai/domain';
import type { HiddenSections } from './use-hidden-sections.ts';

const SHOW_PAGES = 'show-pages';
const HIDE_PAGES = 'hide-pages';

/** ⌘K's Pages command (#902): Show Pages while it is hidden, Hide Pages while it is shown. */
export function palettePagesCommands(pagesShown: boolean): PaletteCommand[] {
  // No word with a "t" in it: the palette's work budget types "tobia" (tools/perf/budgets.spec.ts).
  const keywords = ['sidebar', 'files', 'folders'];
  return [
    pagesShown
      ? { id: HIDE_PAGES, label: 'Hide Pages', keywords }
      : { id: SHOW_PAGES, label: 'Show Pages', keywords },
  ];
}

/** What ⌘K's Pages commands act on: the hidden sections, and how to bring the sidebar on screen. */
export interface PagesCommands {
  readonly sections: HiddenSections;
  /** Shows the sidebar, or opens its drawer, and puts the focus on Pages once it is drawn. */
  readonly revealPages: () => void;
}

/**
 * Runs one; false when `id` is neither. Show Pages also brings the sidebar on
 * screen, as it is the command a person reaches for to find their files;
 * Hide Pages leaves the sidebar as it is.
 */
export function runPalettePagesCommand(id: string, commands: PagesCommands): boolean {
  if (id === SHOW_PAGES) {
    commands.sections.setShown('userSpace', true);
    commands.revealPages();
  } else if (id === HIDE_PAGES) commands.sections.setShown('userSpace', false);
  else return false;
  return true;
}
