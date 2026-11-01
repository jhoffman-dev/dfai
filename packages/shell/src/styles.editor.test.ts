import { describe, expect, it } from 'vitest';
import { readStylesheet } from './styles.test-support.ts';

/**
 * The editor and the note body by the brief's rules (UI v2 slice 13h, #317):
 * inline code is 12.5 mono on the code ground with a 4px radius; a callout, a
 * table, a bookmark, a shown block and a query block are hairline cards with a
 * 4px radius and no shadow; an image has the same radius; a suggestion popup
 * is a popover — 8px radius, the one shadow content never gets — with 36px
 * rows. Read from the sheet itself, since jsdom draws nothing.
 */

const css = readStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as its selectors and its declarations, in sheet order. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
  selectors: (rule[1] ?? '').split(',').map((part) => part.trim()),
  declarations: new Map(
    [...(rule[2] ?? '').matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((declaration) => [
      declaration[1] ?? '',
      (declaration[2] ?? '').replace(/\s+/g, ' ').trim(),
    ]),
  ),
}));

/** What the sheet says of one selector at rest: its own rules' declarations, later ones winning. */
function styleOf(selector: string): Map<string, string> {
  const own = rules.filter((rule) => rule.selectors.includes(selector));
  if (own.length === 0) throw new Error(`no rule for ${selector}`);
  return new Map(own.flatMap((rule) => [...rule.declarations]));
}

/** The light palette and the two dark ones, each as its declarations. */
function paletteOf(opening: string): Map<string, string> {
  const start = css.indexOf(opening);
  if (start < 0) throw new Error(`no palette ${opening}`);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
  );
}

const palettes = {
  light: paletteOf(":root,\n[data-theme='light']"),
  dark: paletteOf("[data-theme='dark'] {"),
  'system dark': paletteOf(":root:not([data-theme='light'])"),
};

const HAIRLINE_CARDS = [
  '.callout',
  '.editor .tableWrapper',
  '.bookmark',
  '.block-embed',
  '.query-block',
  '.artifact-viewer',
];

describe('the note body (slice 13h)', () => {
  it('sets inline code at the code size, on the code ground, with a chip radius', () => {
    const code = styleOf('.editor code');
    expect(code.get('font-size')).toBe('var(--text-code)');
    expect(code.get('font-family')).toBe('var(--font-mono)');
    // The longhands, so bold or a heading round the code carries its weight into it.
    expect(code.has('font')).toBe(false);
    expect(code.has('font-weight')).toBe(false);
    expect(code.get('background')).toBe('var(--code-bg)');
    expect(code.get('border-radius')).toBe('var(--radius-chip)');
  });

  it('grounds inline code on the hover grey in light and on the well in dark', () => {
    expect(palettes.light.get('--code-bg')).toBe('var(--hover)');
    expect(palettes.dark.get('--code-bg')).toBe('var(--well)');
    expect(palettes['system dark'].get('--code-bg')).toBe('var(--well)');
    // Declared nowhere else: the alias block comes later in the sheet and would win.
    expect(css.match(/--code-bg\s*:/g)).toHaveLength(3);
  });

  it('keeps a code block at the block’s own size, not the inline atom’s', () => {
    expect(styleOf('.editor pre code').get('font-size')).toBe('inherit');
    expect(styleOf('.editor pre').get('font')).toContain('var(--text-mono)');
  });

  it.each(HAIRLINE_CARDS)('draws %s as a hairline card with a 4px radius and no shadow', (card) => {
    const style = styleOf(card);
    expect(style.get('border')).toBe('1px solid var(--line)');
    expect(style.get('border-radius')).toBe('var(--radius-chip)');
    expect(style.get('box-shadow') ?? 'none').toBe('none');
  });

  it('rounds an image at the chip radius', () => {
    expect(styleOf('.image__img').get('border-radius')).toBe('var(--radius-chip)');
  });

  it('draws a suggestion popup as a popover with 36px rows', () => {
    const popup = styleOf('.suggestions');
    expect(popup.get('border-radius')).toBe('var(--radius-popover)');
    expect(popup.get('box-shadow')).toBe('var(--shadow-popover)');
    expect(popup.get('border')).toBe('1px solid var(--line)');
    expect(styleOf('.suggest-option').get('min-height')).toBe('36px');
  });

  it('draws the alt-text and link-hover popups as popovers too', () => {
    for (const popover of ['.image__alt', '.link-hover']) {
      const style = styleOf(popover);
      expect(style.get('border-radius'), popover).toBe('var(--radius-popover)');
      expect(style.get('box-shadow'), popover).toBe('var(--shadow-popover)');
    }
  });

  it('lists linked mentions and a linked page’s sections as hairline rows, not cards', () => {
    expect(styleOf('.mentions__link').get('border-top')).toBe('1px solid var(--line-soft)');
    expect(styleOf('.mentions__link').get('box-shadow') ?? 'none').toBe('none');
    const section = styleOf('.linked__section');
    expect(section.get('border-top')).toBe('1px solid var(--line)');
    expect(section.get('box-shadow') ?? 'none').toBe('none');
    expect(section.get('background') ?? 'none').toBe('none');
  });

  it('keeps every weight in the body to 400, 500 or 600', () => {
    const body =
      /^\.(editor|callout|bookmark|block-embed|query-block|linked|mentions|suggest|image|artifact|wikilink|raw-block|viewer|mention-pending|person-avatar|file-drop|gallery-group|new-artifact|link-hover|thumbnail-value)/;
    const heavy = rules
      .filter((rule) => rule.selectors.some((selector) => body.test(selector)))
      .map((rule) => ({ rule, weight: weightOf(rule.declarations) }))
      .filter(({ weight }) => weight !== null && !['400', '500', '600', 'inherit'].includes(weight))
      .map(({ rule, weight }) => `${rule.selectors.join(', ')} -> ${weight ?? ''}`);
    expect(heavy).toEqual([]);
  });
});

/**
 * The weight a rule sets: from `font-weight`, or from a `font:` shorthand,
 * whichever is written last, since the later one wins in the cascade. A
 * shorthand's weight is any weight token before its size — `small-caps 800`,
 * `oblique 800` and `650` all count.
 */
function weightOf(declarations: Map<string, string>): string | null {
  let weight: string | null = null;
  for (const [property, value] of declarations) {
    if (property === 'font-weight') weight = value;
    else if (property === 'font') weight = shorthandWeight(value);
  }
  return weight;
}

const WEIGHT_TOKEN = /^(bold|bolder|lighter|[1-9]\d{0,2}|1000)$/;
const SIZE_TOKEN = /^[\d.]+(px|em|rem|%)|^var\(|\//;

function shorthandWeight(shorthand: string): string | null {
  if (shorthand === 'inherit') return null;
  for (const token of shorthand.split(/\s+/)) {
    if (SIZE_TOKEN.test(token)) return null;
    if (WEIGHT_TOKEN.test(token)) return token;
  }
  return null;
}
