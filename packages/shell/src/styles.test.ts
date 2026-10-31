import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUS_TONES } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import {
  importedSections,
  readIndex,
  readStylesheet,
  sectionFilesOnDisk,
} from './styles.test-support.ts';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
/** The app's sheet: every section file under `styles/`, joined in the order `index.css` imports them. */
const css = readStylesheet();
/** The gallery's own sheet, loaded beside the app's and held to the same palette rule. */
const galleryCss = read('../../../apps/desktop/src/gallery/gallery.css');

/**
 * A stylesheet with its comments taken out.
 *
 * Rules are found by looking at what sits between braces, and a comment before
 * a rule hides that rule from a scan that expects a brace or the start of the
 * file in front of every selector. The first version of this file had exactly
 * that hole, and it made the last check below pass over the bug it exists for.
 */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const withoutComments = stripComments(css);

/** Every rule, as its selector and the declarations inside it. */
function rulesOf(source: string) {
  return [...stripComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
    selector: (rule[1] ?? '').trim(),
    body: rule[2] ?? '',
  }));
}
const rules = rulesOf(css);

/**
 * Every `--name:` the stylesheet declares, wherever it declares it.
 *
 * Read from the commentless source for the same reason the rules are: a
 * declaration that has been commented out is not a declaration, and counting
 * it would let this file pass over the very bug it exists to catch.
 */
const declared = new Set(
  [...withoutComments.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1] ?? ''),
);

/**
 * Every `var(--name)` the app's sheet and the gallery's read, with the
 * fallback (if any) alongside. The gallery's sheet is loaded beside the
 * app's, so it reads the same tokens and is held to the same declarations.
 */
const used = [...(css + galleryCss).matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)].map((match) => ({
  name: match[1] ?? '',
  hasFallback: match[2] === ',',
}));

/** A hex colour, or one written as a function — what a token should hold. */
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

/**
 * Whether a rule only declares the palette: every selector in it is `:root`,
 * a `[data-theme=…]` block, or `:root` with or without one — nothing that
 * reaches an element. `[data-theme='dark'] .card` styles a card, not a theme.
 */
const THEME_SELECTOR = /^(?::root)?(?::not\(\[data-theme='[a-z]+'\]\)|\[data-theme='[a-z]+'\])?$/;
function isTokenBlock(selector: string): boolean {
  return selector
    .split(',')
    .map((part) => part.trim())
    .every((part) => part !== '' && THEME_SELECTOR.test(part));
}

/**
 * Raw colours written anywhere but a token's declaration inside a palette block.
 * Even there, only `--*:` lines may hold one: `:root { background: #fff }` is a
 * component colour that happens to sit on the root.
 */
function rawColourOffenders(source: string): string[] {
  return rulesOf(source).flatMap(({ selector, body }) =>
    body
      .split(';')
      .filter((declaration) => !(isTokenBlock(selector) && declaration.trim().startsWith('--')))
      .flatMap((declaration) =>
        [...declaration.matchAll(RAW_COLOUR)].map((match) => `${selector} -> ${match[0]}`),
      ),
  );
}

/** The tokens declared by the palette blocks whose selector `chosen` picks out. */
function declaredBy(chosen: (selector: string) => boolean): ReadonlySet<string> {
  return new Set(
    rules
      .filter(({ selector }) => isTokenBlock(selector) && chosen(selector))
      .flatMap(({ body }) => [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? '')),
  );
}

/**
 * The three palettes: light, the dark the app chose, and the dark the system
 * asked for. The alias block names light and dark together, so it is none of
 * these — an alias is one line that serves every theme.
 */
const PALETTES = {
  light: declaredBy((s) => s.includes("[data-theme='light']") && !s.includes('dark')),
  dark: declaredBy((s) => s === "[data-theme='dark']"),
  'system dark': declaredBy((s) => s.includes(":not([data-theme='light'])")),
};

const BUTTON_KINDS = ['primary', 'positive', 'destructive', 'secondary', 'ghost'] as const;

describe('the stylesheet', () => {
  /**
   * A token that is read but never declared resolves to nothing, which CSS
   * swallows in silence. This has cost us twice: `--border-strong` was trimmed
   * while two donut slices still referenced it, so both fell back to the same
   * near-invisible grey and the chart lost two of its slices.
   */
  it('declares every token it reads', () => {
    const missing = [
      ...new Set(used.filter((token) => !declared.has(token.name)).map((t) => t.name)),
    ];
    expect(missing).toEqual([]);
  });

  /**
   * A fallback on a token that does exist is dead weight that hides the failure
   * above — the fallback answers, so nobody notices the token went away.
   */
  it('does not paper over a token it declares with a fallback', () => {
    const papered = [
      ...new Set(
        used.filter((token) => token.hasFallback && declared.has(token.name)).map((t) => t.name),
      ),
    ];
    expect(papered).toEqual([]);
  });

  /**
   * Colours are roles: a component reads `var(--ink-2)`, never `#4e577a`, so a
   * theme is one block to change and dark cannot drift from light one rule at
   * a time. A raw colour belongs only in a rule that declares tokens — `:root`
   * or a `[data-theme]` block — and this fails the moment one is written
   * anywhere else.
   */
  it.each([
    ['styles/index.css', css],
    ['gallery.css', galleryCss],
  ])('%s writes raw colours only where tokens are declared', (_name, source) => {
    expect(rawColourOffenders(source)).toEqual([]);
  });

  it.each([
    ["[data-theme='dark'] .card { background: #123 }", ["[data-theme='dark'] .card -> #123"]],
    [':root { background: #fff; --ink: #000 }', [':root -> #fff']],
    [".card, [data-theme='dark'] { --edge: rgb(0, 0, 0) }", [".card, [data-theme='dark'] -> rgb("]],
  ])('finds the raw colour in %s', (source, found) => {
    expect(rawColourOffenders(source)).toEqual(found);
  });

  it.each([
    ':root { --ink: #000 }',
    "[data-theme='dark'] { --ink: #fff }",
    ":root:not([data-theme='light']) { --ink: #fff }",
    ":root, [data-theme='light'], [data-theme='dark'] { --edge: rgba(0, 0, 0, 0.1) }",
  ])('lets a palette block declare a token as a raw colour: %s', (source) => {
    expect(rawColourOffenders(source)).toEqual([]);
  });

  /**
   * A `color-mix` resolves where it is written. Declared on `:root` it is
   * computed once against the root's theme and then inherited as a fixed
   * colour, so a subtree carrying its own `data-theme` keeps the wrong one —
   * which is how a selected row in the gallery's dark panel came out lavender.
   *
   * A mix inside an ordinary component rule is fine: it resolves at that
   * element, against whatever theme the element is under. Only the root-level
   * ones have to name every theme they are meant to serve.
   */
  it('gives a root-level colour mix a value for every theme', () => {
    const offenders: string[] = [];

    for (const { selector, body } of rules) {
      if (!selector.includes(':root')) continue;

      const mixes = [...body.matchAll(/(--[a-z0-9-]+)\s*:[^;]*color-mix/g)].map(
        (match) => match[1] ?? '',
      );
      if (mixes.length === 0) continue;

      // Either this very rule serves the dark theme too, or another rule must.
      const servesDark =
        selector.includes("[data-theme='dark']") ||
        mixes.every((name) =>
          rules.some(
            (other) =>
              other.selector.includes("[data-theme='dark']") &&
              new RegExp(`${name}\\s*:`).test(other.body),
          ),
        );

      if (!servesDark) offenders.push(`${selector} -> ${mixes.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });

  /**
   * A palette token with a light value and no dark one keeps its light value
   * on a dark surface — pale text on a pale tint — and nobody notices until
   * the theme is switched. So the three palettes declare the same tokens,
   * and each is checked to hold something, or an empty set would pass.
   */
  it('declares every palette token in light, dark and the system dark', () => {
    for (const [palette, tokens] of Object.entries(PALETTES)) {
      expect(tokens.has('--ink'), `${palette} declares --ink`).toBe(true);
    }
    const union = new Set(Object.values(PALETTES).flatMap((tokens) => [...tokens]));
    const gaps = Object.entries(PALETTES).flatMap(([palette, tokens]) =>
      [...union].filter((token) => !tokens.has(token)).map((token) => `${palette} lacks ${token}`),
    );
    expect(gaps).toEqual([]);
  });

  /**
   * Every tone a status can take is drawn three ways — its dot, its pill's
   * text and its pill's tint — and the list is the domain's, so a tone added
   * there without its colours fails here rather than drawing in nothing.
   */
  it.each(STATUS_TONES)('gives the %s tone a dot, an ink and a tint in every palette', (tone) => {
    const missing = Object.entries(PALETTES).flatMap(([palette, tokens]) =>
      ['dot', 'ink', 'tint']
        .map((part) => `--status-${tone}-${part}`)
        .filter((token) => !tokens.has(token))
        .map((token) => `${palette} lacks ${token}`),
    );
    expect(missing).toEqual([]);
  });

  it.each(STATUS_TONES)('draws the %s tone somewhere', (tone) => {
    expect(rules.some(({ selector }) => selector.includes(`[data-tone='${tone}']`))).toBe(true);
  });

  it.each(BUTTON_KINDS)(
    'gives the %s button a fill, an ink and a line in every palette',
    (kind) => {
      const missing = Object.entries(PALETTES).flatMap(([palette, tokens]) =>
        ['bg', 'ink', 'line']
          .map((part) => `--btn-${kind}-${part}`)
          .filter((token) => !tokens.has(token))
          .map((token) => `${palette} lacks ${token}`),
      );
      expect(missing).toEqual([]);
    },
  );
});

/**
 * The sheet is one file per section, and the index is the only thing that
 * says in what order they cascade. A section file the index forgets is a
 * section the app never loads; every check above would still pass, because
 * it reads what the index imports. So the folder and the index are held to
 * each other here.
 */
describe('the styles folder', () => {
  it('imports every section file in the folder, once each', () => {
    const imported = importedSections();
    expect(imported.length).toBeGreaterThan(1);
    expect([...imported].sort()).toEqual(sectionFilesOnDisk());
  });

  /**
   * A rule written in the index itself would sit before or after every
   * section without belonging to one, and a scan of the sections would never
   * see it. The index holds imports and comments, nothing else.
   */
  it('keeps index.css to imports alone', () => {
    const lines = stripComments(readIndex())
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(lines.every((line) => /^@import '\.\/[a-z0-9-]+\.css';$/.test(line))).toBe(true);
  });

  /** The palette comes first, so every file after it reads tokens that are already declared. */
  it('imports tokens.css first', () => {
    expect(importedSections()[0]).toBe('tokens.css');
  });
});

/**
 * The v2 rules, pinned for good (UI v2 slice 15, `Tokens.dc.html`'s rules
 * list): content never floats — a shadow with a blur is for what floats over
 * the page or is in the hand while dragged; nothing is rounder than 8px but
 * a round mark (50%: a dot, an avatar, a swatch, a spinner); no capitals by
 * CSS; no weight above 600.
 *
 * What breaks a rule today is named below, so the lists can only shrink:
 * each is a follow-up of slice 15, left as it is because fixing it changes
 * what is drawn. A new offender fails, and so does one fixed but still listed.
 */
/** Rounder than 8px today: pill shapes, the switch, the selection bar, a 14px popover. */
const ROUND_EXCEPTIONS: readonly string[] = [
  '.callout__title::before',
  '.checklist-progress__track',
  '.inbox__file',
  '.index-progress',
  '.new-view__layout',
  '.pane--focused::before',
  '.proposals__notice',
  '.selection-bar',
  '.selection-bar__action',
  '.selection-bar__clear',
  '.star',
  '.toggle',
  '.toggle__knob',
  '.tree__more',
  '.view-popover',
  '.widget-sheet__icon',
  '.widget-sheet__kind',
  '.widget__grip',
  '.widget__resize::after',
];
/** Capitals set by CSS today. */
const CAPITALS_EXCEPTIONS: readonly string[] = [
  '.artifact-face__status',
  '.card__label',
  '.new-type__legend',
  '.proposal-row__kind',
  '.query__schema-title',
];
/** Heavier than 600 today. */
const HEAVY_EXCEPTIONS: readonly string[] = [
  '.confirm__title',
  '.granola__details summary',
  '.graph__edge-label',
  '.inbox__grid th',
  '.links__heading',
  '.new-type__legend',
  '.new-type__title',
  '.new-view__layout',
  '.note-chip',
  '.proposals__heading',
  '.props__chip-select',
  '.props__link',
  '.props__pill-select',
  '.selection-bar',
  '.view-popover__direction',
  '.view-popover__submit',
  '.view-popover__title',
];

describe('the v2 rules', () => {
  /**
   * A selector's block, judged with its BEM elements and modifiers and its
   * states: `.menu`, `.menu__item`, `.menu--wide`, `.menu:hover`,
   * `.menu .x` — never `.menu-positioner`, a block of its own.
   */
  const block = (names: string) => new RegExp(`^\\.(${names})(?=$|__|--|[\\s.:,[>+~])`);
  /** Surfaces that float over the page: menus, popovers, palettes, the peek's previews, toasts. */
  const FLOATS = block(
    'menu|palette|lightbox|toast|peek|link-preview|link-hover|suggestions|link-suggest|cell-picker|view-popover|filter-value__list|image__alt|widget-sheet|[a-z-]*popover',
  );
  /** Something in the hand while it is dragged, lifted off the page. */
  const IN_HAND = /--(lifted|held)\b|^\.widget-ghost(?=$|__|--|[\s.:,[>+~])/;

  /** Every token the sheet declares, by name, as first declared (a radius has one value). */
  const tokenValues = new Map<string, string>();
  for (const match of withoutComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (!tokenValues.has(match[1] ?? '')) tokenValues.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  /** A value with its `var()`s read as the tokens' own values, as deep as they go. */
  function resolved(value: string, depth = 0): string {
    if (depth > 5) return value;
    const next = value.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (_, name: string) => {
      return tokenValues.get(name) ?? name;
    });
    return next === value ? value : resolved(next, depth + 1);
  }

  /** A value's comma-separated parts, not counting the commas inside a function's brackets. */
  function topLevelParts(value: string): string[] {
    const parts = [''];
    let depth = 0;
    for (const character of value) {
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (character === ',' && depth === 0) parts.push('');
      else parts[parts.length - 1] += character;
    }
    return parts;
  }

  /** A shadow with a blur, or one of the floating shadow tokens. */
  const floats = (value: string) =>
    /--shadow-(popover|overlay)\b/.test(value) ||
    topLevelParts(resolved(value)).some((part) => {
      // Its lengths, colours (and their numbers) left out: x, y, blur, spread.
      const bare = part.replace(/[a-z-]+\([^()]*(\([^()]*\)[^()]*)*\)/g, ' ');
      const lengths = [...bare.matchAll(/(-?\d*\.?\d+)(px)?/g)].map((match) => Number(match[1]));
      return !part.includes('inset') && lengths.length >= 3 && (lengths[2] ?? 0) > 0;
    });

  /** Rounder than 8px — the shorthand or any corner, tokens read as their values — and not a round mark's 50%. */
  const tooRound = (value: string) =>
    [...resolved(value).matchAll(/(\d+(?:\.\d+)?)px/g)].some((match) => Number(match[1]) > 8);

  const declarationsOf = (body: string) =>
    [...body.matchAll(/(?<![\w-])([a-z-]+)\s*:\s*([^;]+);/g)].map((match) => ({
      property: match[1] ?? '',
      value: (match[2] ?? '').replace(/\s+/g, ' ').trim(),
    }));

  /** The selectors of `source` that break each rule, each selector of a list judged on its own. */
  function offenders(source: string) {
    const found = {
      shadows: [] as string[],
      radii: [] as string[],
      capitals: [] as string[],
      heavy: [] as string[],
    };
    for (const { selector, body } of rulesOf(source)) {
      const names = selector
        .split(',')
        .map((name) => name.replace(/\s+/g, ' ').trim())
        .filter((name) => name !== '' && !name.startsWith(':root') && !name.startsWith('@'));
      for (const { property, value } of declarationsOf(body)) {
        for (const name of names) {
          const allowedToFloat = FLOATS.test(name) || IN_HAND.test(name);
          if (property === 'box-shadow' && floats(value) && !allowedToFloat)
            found.shadows.push(name);
          if (/^border(-[a-z]+)*-radius$/.test(property) && tooRound(value)) found.radii.push(name);
          if (property === 'text-transform' && value.includes('uppercase'))
            found.capitals.push(name);
          if (property === 'font-weight' && Number.parseInt(resolved(value), 10) > 600)
            found.heavy.push(name);
        }
      }
    }
    return found;
  }

  const today = offenders(css);
  const sorted = (list: readonly string[]) => [...new Set(list)].sort();

  it('reads a BEM element of a floating block as floating, and a block of its own as not', () => {
    expect(FLOATS.test('.menu__item')).toBe(true);
    expect(FLOATS.test('.menu--wide')).toBe(true);
    expect(FLOATS.test('.menu:hover')).toBe(true);
    expect(FLOATS.test('.menu-positioner')).toBe(false);
    expect(FLOATS.test('.menubar')).toBe(false);
  });

  it('lets only what floats over the page, or is being dragged, cast a shadow', () => {
    expect(sorted(today.shadows)).toEqual([]);
  });

  it('would catch a shadow on the panel, a 12px radius on a card, and either in a list (mutation guard)', () => {
    const mutated = offenders(
      `${css}\n.panel { box-shadow: var(--shadow-popover); }\n.card { border-radius: 12px; }`,
    );
    expect(mutated.shadows).toEqual(['.panel']);
    expect(mutated.radii).toContain('.card');
    const listed = offenders(`${css}\n.menu, .panel { box-shadow: 0 8px 24px var(--line); }`);
    expect(listed.shadows).toEqual(['.panel']);
    const corner = offenders(`${css}\n.card { border-top-left-radius: var(--radius-pill); }`);
    expect(corner.radii).toContain('.card');
    expect(
      offenders(`${css}\n.card { text-transform: uppercase; font-weight: 700; }`),
    ).toMatchObject({
      capitals: expect.arrayContaining(['.card']),
      heavy: expect.arrayContaining(['.card']),
    });
  });

  it('rounds nothing past 8px but its round marks — save the pill shapes still listed', () => {
    expect(sorted(today.radii)).toEqual(sorted(ROUND_EXCEPTIONS));
  });

  it('sets no capitals by CSS — save the labels still listed', () => {
    expect(sorted(today.capitals)).toEqual(sorted(CAPITALS_EXCEPTIONS));
  });

  it('weighs nothing above 600 — save the headings and chips still listed', () => {
    expect(sorted(today.heavy)).toEqual(sorted(HEAVY_EXCEPTIONS));
  });
});
