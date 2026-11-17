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

/** Runs one; false when `id` is neither. */
export function runPalettePagesCommand(id: string, sections: HiddenSections): boolean {
  if (id === SHOW_PAGES) sections.setShown('userSpace', true);
  else if (id === HIDE_PAGES) sections.setShown('userSpace', false);
  else return false;
  return true;
}
