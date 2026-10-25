import {
  MOST_CHAPTER_LOOKUPS,
  SHEET_LIMITS,
  sheetMade,
  type SheetLimits,
  type FileAddress,
  type LookupBudget,
  type MadeSheet,
} from './chapter-styles.ts';

/*
 * A book's stylesheets with their `@import`s put in place (#505, ADR-0045
 * §5). Each of the book's sheets is read and made once per open book
 * (`chapter-styles.ts`), and a sheet that imports others is written out
 * with each of them before its own rules, as a browser would load them. A
 * sheet is put in at most once in one sheet written out, however often it is
 * imported, and the sheets one chapter links and imports are bounded together:
 * `MOST_IMPORTS` sheets, `MOST_IMPORT_DEPTH` deep, and `MOST_IMPORTED_LENGTH`
 * characters of them. So a book that imports itself over and over costs no
 * more than one that does not.
 */

/** How deep `@import`s are followed. */
export const MOST_IMPORT_DEPTH = 4;
/** The most of the book's stylesheets one chapter may put in, linked or imported: a book has a handful. */
export const MOST_IMPORTS = 64;
/** The most all of those sheets may be together, in characters, as the book wrote them. */
export const MOST_IMPORTED_LENGTH = 4 * 1024 * 1024;

/** What one chapter's CSS has put in so far, and the longhands its own CSS has read. */
export interface StyleBudget extends LookupBudget {
  imports: number;
  length: number;
}

/** How much of the book's CSS one chapter may take: today's limits are the defaults, and a test may make them small. */
export interface StyleLimits extends SheetLimits {
  readonly imports: number;
  readonly importDepth: number;
  readonly importedLength: number;
  /** The most longhands and rules read in all of one chapter's own `<style>`s and `style=`s. */
  readonly chapterLookups: number;
}

export const STYLE_LIMITS: StyleLimits = {
  ...SHEET_LIMITS,
  imports: MOST_IMPORTS,
  importDepth: MOST_IMPORT_DEPTH,
  importedLength: MOST_IMPORTED_LENGTH,
  chapterLookups: MOST_CHAPTER_LOOKUPS,
};

export const styleBudget = (limits: StyleLimits = STYLE_LIMITS): StyleBudget => ({
  imports: 0,
  length: 0,
  lookups: 0,
  most: limits.chapterLookups,
});

export interface BookStyles {
  /** `css`, written in the book's file at `from`, made, its imports in place, within `budget`. */
  css(css: string, from: string, budget?: StyleBudget): Promise<string>;
  /** The book's stylesheet at `path`, made, its imports in place, within `budget`; empty when there is none. */
  sheet(path: string, budget?: StyleBudget): Promise<string>;
}

/** What putting a sheet's imports in needs: each of the book's sheets, made, and the limits. */
interface Importing {
  readonly madeAt: (path: string) => Promise<MadeSheet | null>;
  readonly limits: StyleLimits;
}

/** The book's stylesheets, each read by `stylesheet` and made once. */
export function bookStyles({
  address,
  stylesheet,
  limits = STYLE_LIMITS,
}: {
  address: FileAddress;
  stylesheet: (path: string) => Promise<string | null>;
  limits?: StyleLimits;
}): BookStyles {
  const sheets = new Map<string, Promise<MadeSheet | null>>();
  const madeAt = (path: string): Promise<MadeSheet | null> => {
    const found = sheets.get(path);
    if (found !== undefined) return found;
    const made = stylesheet(path).then((css) =>
      css === null || css.length > limits.sheetLength
        ? null
        : sheetMade({ css, from: path, address, limits }),
    );
    sheets.set(path, made);
    // One that failed is made again the next time it is asked for.
    made.catch(() => sheets.delete(path));
    return made;
  };
  const importing: Importing = { madeAt, limits };
  const written = (top: MadeSheet, from: string, budget: StyleBudget) =>
    withImports({ sheet: top, depth: 0, seen: new Set([from]), budget, importing });
  return {
    css: async (css, from, budget = styleBudget(limits)) =>
      written(await sheetMade({ css, from, address, limits, budget }), from, budget),
    sheet: async (path, budget = styleBudget(limits)) => {
      // A linked sheet counts against its chapter's budget as an imported one does.
      if (budget.imports >= limits.imports) return '';
      budget.imports += 1;
      const top = await madeAt(path);
      if (top === null || budget.length + top.length > limits.importedLength) return '';
      budget.length += top.length;
      return written(top, path, budget);
    },
  };
}

/** `css`, written in the book's file at `from`, made, each of the book's sheets it imports read by `stylesheet`. */
export function bookCss({
  css,
  from,
  address,
  stylesheet,
  limits = STYLE_LIMITS,
}: {
  css: string;
  from: string;
  address: FileAddress;
  stylesheet: (path: string) => Promise<string | null>;
  limits?: StyleLimits;
}): Promise<string> {
  return bookStyles({ address, stylesheet, limits }).css(css, from);
}

/** `sheet` written out, each sheet it imports before its own rules, those not yet `seen`, within `budget`. */
async function withImports({
  sheet,
  depth,
  seen,
  budget,
  importing,
}: {
  sheet: MadeSheet;
  depth: number;
  seen: Set<string>;
  budget: StyleBudget;
  importing: Importing;
}): Promise<string> {
  const { madeAt, limits } = importing;
  const parts: string[] = [];
  for (const path of depth < limits.importDepth ? sheet.imports : []) {
    if (seen.has(path)) continue;
    if (budget.imports >= limits.imports) break;
    seen.add(path);
    budget.imports += 1;
    const imported = await madeAt(path);
    if (imported === null || budget.length + imported.length > limits.importedLength) continue;
    budget.length += imported.length;
    parts.push(await withImports({ sheet: imported, depth: depth + 1, seen, budget, importing }));
  }
  parts.push(sheet.own);
  return parts.filter((part) => part !== '').join('\n');
}
