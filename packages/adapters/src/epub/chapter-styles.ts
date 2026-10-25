import { bookReference } from '@dfai/domain';
import {
  declarationsIn,
  importsIn,
  namesAddress,
  namesStringOrAddress,
  namesUnknownFunction,
  nestsDeeperThan,
  valueMade,
  type AddressMade,
  type Declaration,
} from './css-references.ts';

/*
 * One of a book's stylesheets, made to load only from the book (#505,
 * ADR-0045 §5). The CSS is read by the browser's own parser, into a
 * constructed stylesheet that is never adopted: it fetches nothing and
 * ignores every `@import`. Each rule is walked, into `@media`, `@supports`,
 * `@layer`, `@keyframes` and nested rules, and each declaration's addresses
 * (`css-references.ts`) are read against the file the CSS is written in: one
 * of the book's files becomes the address the frame loads it from, its
 * `#place` kept; one written in (`data:`) or a place in the chapter (`#id`)
 * stays; and a declaration naming anything else is dropped. A rule of another
 * kind that names an address it cannot keep as written is dropped whole. The
 * sheet is written out again as the parser serialises it, so what the frame
 * is given is what a browser read, not the book's spelling of it.
 *
 * The parser drops `@import`, so the book's own imports are found in its
 * text first (`importsIn`), for `book-styles.ts` to put before its rules.
 *
 * This runs in the app's own window, so a sheet is bounded before it is
 * read: one longer than `MOST_SHEET_LENGTH`, or nesting brackets deeper than
 * `MOST_NESTING` (WebKit's parser reads those in quadratic time), is dropped
 * whole; a rule listing more than `MOST_RULE_LENGTH` longhands has its
 * declarations dropped (WebKit finds each by walking the list); and once
 * `MOST_LOOKUPS` longhands and rules have been read in a sheet (or
 * `MOST_CHAPTER_LOOKUPS` in a chapter's own CSS), every further rule's
 * declarations are dropped.
 */

/** How the frame loads a file of the book: its address, or null when the book has no such file. */
export type FileAddress = (path: string) => Promise<string | null>;

/** The most one sheet may be, in characters; a longer one is dropped whole, before it is read. */
export const MOST_SHEET_LENGTH = 2 * 1024 * 1024;
/** How deep a sheet may nest its brackets; a book nests a few deep. */
export const MOST_NESTING = 32;
/** The most longhands (and rules) read in one sheet: a long book's sheet has a few thousand. */
export const MOST_LOOKUPS = 50_000;
/** The most read in all of one chapter's own `<style>`s and `style=`s: one per element of a long chapter. */
export const MOST_CHAPTER_LOOKUPS = 200_000;
/** The most declarations one rule may list, as longhands: `all` is 445 of them. */
export const MOST_RULE_LENGTH = 1_024;

/** The longhands read so far, and the most that may be. */
export interface LookupBudget {
  lookups: number;
  readonly most: number;
}

/** How much of a sheet is read: today's limits are the defaults, and a test may make them small. */
export interface SheetLimits {
  readonly sheetLength: number;
  readonly nesting: number;
  readonly ruleLength: number;
  /** The most longhands and rules read in one sheet. */
  readonly lookups: number;
}

export const SHEET_LIMITS: SheetLimits = {
  sheetLength: MOST_SHEET_LENGTH,
  nesting: MOST_NESTING,
  ruleLength: MOST_RULE_LENGTH,
  lookups: MOST_LOOKUPS,
};

const sheetBudget = (limits: SheetLimits): LookupBudget => ({ lookups: 0, most: limits.lookups });

/** One sheet of the book made: the book's files its `@import`s name, in order, and its own rules made. */
export interface MadeSheet {
  readonly imports: readonly string[];
  readonly own: string;
  /** How long the book's sheet was, as written. */
  readonly length: number;
}

/** How a sheet is made: what each address becomes, and the longhands it may still read. */
interface Making {
  readonly made: AddressMade;
  readonly budget: LookupBudget;
  readonly limits: SheetLimits;
}

/**
 * `css`, written in the book's file at `from`, made: its own rules with
 * every reference made the book's own or dropped, and the paths of the
 * book's own sheets it imports. Nothing at all of a sheet too long or too
 * deeply nested.
 */
export async function sheetMade({
  css,
  from,
  address,
  limits = SHEET_LIMITS,
  budget = sheetBudget(limits),
}: {
  css: string;
  from: string;
  address: FileAddress;
  limits?: SheetLimits | undefined;
  budget?: LookupBudget | undefined;
}): Promise<MadeSheet> {
  if (css.length > limits.sheetLength || nestsDeeperThan(css, limits.nesting)) {
    return { imports: [], own: '', length: css.length };
  }
  const imports: string[] = [];
  for (const ref of importsIn(css)) {
    const target = bookReference({ from, ref });
    if (target.kind === 'inside') imports.push(target.path);
  }
  const sheet = parsed(css);
  await rulesMade(sheet, { made: addressMade({ from, address }), budget, limits });
  const own = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
  return { imports, own, length: css.length };
}

/** `style`, a `style=` written in the book's file at `from`, its declarations made the same way. */
export async function bookDeclarations({
  style,
  from,
  address,
  limits = SHEET_LIMITS,
  budget = sheetBudget(limits),
}: {
  style: string;
  from: string;
  address: FileAddress;
  limits?: SheetLimits | undefined;
  budget?: LookupBudget | undefined;
}): Promise<string> {
  if (style.length > limits.sheetLength || nestsDeeperThan(style, limits.nesting)) return '';
  // A rule around the declarations, read as a style attribute is; anything after a `}` that
  // closes it early is another rule, and is left out.
  const first = parsed(`*{${style}\n}`).cssRules[0];
  if (!(first instanceof CSSStyleRule)) return '';
  await declarationsMade(first.style, {
    made: addressMade({ from, address }),
    budget,
    limits,
  });
  return first.style.cssText;
}

/** `css` read by the browser's parser, into a sheet no document adopts: it loads nothing. */
function parsed(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet;
}

/** What each address becomes, read against `from`: kept, the book's file's address, or null to drop it. */
function addressMade({ from, address }: { from: string; address: FileAddress }): AddressMade {
  return async (ref) => {
    // A place in the chapter itself (`#id`), or a file written in, loads nothing.
    if (ref.trim().startsWith('#')) return 'keep';
    const target = bookReference({ from, ref });
    if (target.kind === 'data') return 'keep';
    if (target.kind === 'outside') return null;
    const found = await address(target.path);
    if (found === null) return null;
    return target.fragment === null ? found : `${found}#${encodeURIComponent(target.fragment)}`;
  };
}

/** A rule list the parser gave, and how one of its rules is taken out. */
interface RuleList {
  readonly cssRules: CSSRuleList;
  deleteRule?(index: number): void;
}

/** Every rule in `list`, and the rules inside each, made the book's own; a rule that cannot be is taken out. */
async function rulesMade(list: RuleList, making: Making): Promise<void> {
  for (let at = list.cssRules.length - 1; at >= 0; at -= 1) {
    const rule = list.cssRules[at];
    if (rule === undefined || rule instanceof CSSNamespaceRule) continue;
    if (rule instanceof CSSImportRule) {
      takeOut(list, at);
      continue;
    }
    const style = 'style' in rule ? (rule.style as CSSStyleDeclaration) : null;
    const inner = 'cssRules' in rule ? (rule as unknown as RuleList) : null;
    if (style !== null) await declarationsMade(style, making);
    if (inner !== null) await rulesMade(withDelete(inner), making);
    if (style === null && inner === null && (await namesAddress(rule.cssText, making.made))) {
      // An `@property`, an `@counter-style`: it holds no declarations to drop one of.
      takeOut(list, at);
    }
  }
}

function takeOut(list: RuleList, at: number): void {
  // Never left in when it cannot be taken out: the rule names what may not stay.
  if (list.deleteRule === undefined) throw new Error('a rule of the book could not be taken out');
  list.deleteRule(at);
}

/**
 * `list`, taking a rule out by its place. A `@keyframes` takes one out by
 * its key instead, and holds only keyframes, whose declarations are made in
 * place; none is ever taken out of it.
 */
function withDelete(list: RuleList): RuleList {
  return list instanceof CSSKeyframesRule ? { cssRules: list.cssRules } : list;
}

/** Each declaration in `style` with its addresses made; one naming an address that may not stay is dropped. */
async function declarationsMade(
  style: CSSStyleDeclaration,
  { made, budget, limits }: Making,
): Promise<void> {
  // Each declaration of a rule is found by walking its list in WebKit, so a long one costs the
  // square of its length: it, and every rule past the budget, is dropped before any is read.
  const length = style.length;
  budget.lookups += Math.max(length, 1);
  if (length > limits.ruleLength || budget.lookups > budget.most) {
    style.cssText = '';
    return;
  }
  dropUnknownAll(style);
  // A custom property is read whole below, as the rule writes it out.
  const names = Array.from({ length: style.length }, (_, at) => style.item(at)).filter(
    (name) => !name.startsWith('--'),
  );
  // The addresses given here are the book's own files: read again below, they stay.
  const given = new Set<string>();
  const giving: AddressMade = async (ref) => {
    const next = await made(ref);
    if (next !== null && next !== 'keep') given.add(next);
    return next;
  };
  await longhandsMade(style, names, giving);
  await writtenOutMade(style, async (ref) => (given.has(ref) ? 'keep' : made(ref)));
}

/**
 * `style` without an `all` built from `var()`: it stands for every longhand
 * there is, each one empty until the page is styled, and reading each costs
 * time for nothing.
 */
function dropUnknownAll(style: CSSStyleDeclaration): void {
  const written = declarationsIn(style.cssText);
  const unknownAll = ({ name, value }: Declaration) =>
    name.toLowerCase() === 'all' && namesUnknownFunction(value);
  if (!written.some(unknownAll)) return;
  style.cssText = written
    .filter((declaration) => !unknownAll(declaration))
    .map(({ text }) => text)
    .join(' ');
}

/** Each of `names`, a longhand `style` lists, its addresses made. */
async function longhandsMade(
  style: CSSStyleDeclaration,
  names: readonly string[],
  made: AddressMade,
): Promise<void> {
  for (const name of names) {
    const value = style.getPropertyValue(name);
    const next = await valueMade(value, made);
    if (next === value) continue;
    if (next !== null) {
      style.setProperty(name, next, style.getPropertyPriority(name));
      // A value the parser refuses leaves the old one: that one may not stay either.
      if (style.getPropertyValue(name) !== value) continue;
    }
    style.removeProperty(name);
  }
}

/**
 * Each declaration as `style` writes it out, shorthands and all, read
 * again: WebKit writes a shorthand built with `var()` out as the book spelled
 * it, every longhand of it empty, so reading longhand by longhand never saw
 * what is inside it. One that may not stay is dropped; if the parser keeps
 * any such one, none of the declarations stay.
 */
async function writtenOutMade(style: CSSStyleDeclaration, made: AddressMade): Promise<void> {
  const written = declarationsIn(style.cssText);
  const kept: string[] = [];
  for (const declaration of written) {
    if (!(await mayNotStay(declaration, made))) kept.push(declaration.text);
  }
  if (kept.length === written.length) return;
  style.cssText = kept.join(' ');
  for (const declaration of declarationsIn(style.cssText)) {
    if (await mayNotStay(declaration, made)) {
      style.cssText = '';
      return;
    }
  }
}

/**
 * Whether `declaration` names an address that may not stay, builds one from
 * `var()`, `env()` or `attr()`, or is a custom property that could give a
 * `var()` an address: a string, a `url()` or an address function.
 */
async function mayNotStay({ name, value }: Declaration, made: AddressMade): Promise<boolean> {
  if (name.startsWith('--') && namesStringOrAddress(value)) return true;
  return namesAddress(value, made);
}
