import { describe, expect, it } from 'vitest';
import { readStylesheet } from './styles.test-support.ts';

/**
 * The list, gallery and feed layouts by the brief's rules (UI v2 slice 13d,
 * #313): list rows are the table's 34px rows on `line-soft`; a gallery card
 * is the board's card — square, one hairline, no shadow and no lift under the
 * pointer; the feed's rows and its done boxes sit on `line-soft`; nothing
 * casts a shadow. Read from the sheet itself, since jsdom draws nothing, and
 * every text run the layouts draw is held to AA on the ground it sits on.
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

/** What the sheet says of one selector: its own rules' declarations, later ones winning. */
function styleOf(selector: string): Map<string, string> {
  const own = rules.filter((rule) => rule.selectors.includes(selector));
  if (own.length === 0) throw new Error(`no rule for ${selector}`);
  return new Map(own.flatMap((rule) => [...rule.declarations]));
}

const hasRule = (selector: string) => rules.some((rule) => rule.selectors.includes(selector));

/** A palette block (the light one, or either dark one) as its declarations. */
function paletteOf(opening: string): Map<string, string> {
  const start = css.indexOf(opening);
  if (start < 0) throw new Error(`no palette ${opening}`);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
  );
}

const aliases = paletteOf("[data-theme='light'],\n[data-theme='dark'] {");
const palettes = {
  light: paletteOf(":root,\n[data-theme='light']"),
  dark: paletteOf("[data-theme='dark'] {"),
  'system dark': paletteOf(":root:not([data-theme='light'])"),
};

type Rgb = readonly [number, number, number];

function rawValue(theme: Map<string, string>, name: string): string {
  let value = theme.get(name) ?? aliases.get(name);
  for (let hops = 0; value?.startsWith('var(') === true && hops < 10; hops += 1) {
    const next = value.slice(4, -1).trim();
    value = theme.get(next) ?? aliases.get(next);
  }
  if (value === undefined) throw new Error(`${name} does not resolve`);
  return value;
}

/** A token as the colour on screen: a hex as is, an rgba() laid over the surface. */
function paint(theme: Map<string, string>, name: string): Rgb {
  const value = rawValue(theme, name);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as unknown as Rgb;
  }
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba === null) throw new Error(`${name} is neither hex nor rgba (${value})`);
  const alpha = Number(rgba[4]);
  const under = paint(theme, '--surface');
  return [1, 2, 3].map(
    (at) => Number(rgba[at]) * alpha + (under[at - 1] ?? 0) * (1 - alpha),
  ) as unknown as Rgb;
}

const channel = (value: number) => {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('the list layout (slice 13d)', () => {
  it('is drawn edge to edge, with no card around it', () => {
    const list = styleOf('.list-view');
    expect(list.get('padding')).toBe('0');
    expect(list.has('background')).toBe(false);
    expect(list.has('box-shadow')).toBe(false);
  });

  it('draws 34px rows divided by line-soft, lit by the hover fill', () => {
    const row = styleOf('.list-view__row');
    expect(row.get('height')).toBe('34px');
    expect(row.get('border-bottom')).toBe('1px solid var(--line-soft)');
    expect(styleOf('.list-view__row:hover').get('background')).toBe('var(--hover)');
  });

  it('lets the fields give way in a narrow pane, cut at the row’s edge, before the title', () => {
    const fields = styleOf('.list-view__fields');
    expect(fields.get('flex')).toBe('0 1 auto');
    expect(fields.get('min-width')).toBe('0');
    expect(fields.get('overflow')).toBe('hidden');
    const title = styleOf('.list-view__title');
    expect(title.get('flex')).toBe('none');
    expect(title.get('text-overflow')).toBe('ellipsis');
  });

  it('makes the title the one emphasised thing on the row, the summary metadata', () => {
    const title = styleOf('.list-view__title');
    expect(title.get('font-size')).toBe('var(--text-emphasis)');
    expect(title.get('font-weight')).toBe('500');
    expect(title.get('color')).toBe('var(--ink)');
    const summary = styleOf('.list-view__summary');
    expect(summary.get('color')).toBe('var(--ink-3)');
    expect(summary.get('font-size')).toBe('var(--text-meta)');
  });
});

describe('the gallery layout (slice 13d)', () => {
  it('draws a card as the board does: square, one hairline, no shadow', () => {
    const card = styleOf('.gallery__card');
    const board = styleOf('.board__card');
    expect(card.get('border')).toBe('1px solid var(--line)');
    expect(card.get('border')).toBe(board.get('border'));
    expect(card.get('background')).toBe(board.get('background'));
    expect(card.get('border-radius')).toBe('var(--radius-card)');
    expect(paletteOf(':root {').get('--radius-card')).toBe('0');
    expect(card.has('box-shadow')).toBe(false);
    expect(card.has('transform')).toBe(false);
    expect(card.has('transition')).toBe(false);
  });

  it('does not lift under the pointer', () => {
    expect(hasRule('.gallery__card:hover')).toBe(false);
  });

  it('pads the card and sets its title as the board does', () => {
    expect(styleOf('.gallery__body').get('padding')).toBe(styleOf('.board__card').get('padding'));
    const title = styleOf('.gallery__title');
    const board = styleOf('.board__title');
    expect(title.get('font-size')).toBe(board.get('font-size'));
    expect(title.get('font-weight')).toBe(board.get('font-weight'));
    expect(styleOf('.gallery__title-text').get('-webkit-line-clamp')).toBe('2');
    expect(styleOf('.gallery__summary').get('color')).toBe('var(--ink-3)');
  });

  it('keeps the board gap between cards', () => {
    expect(styleOf('.gallery').get('gap')).toBe(styleOf('.board').get('gap'));
  });

  it('still rings the card when its title holds focus', () => {
    expect(styleOf('.gallery__card:has(.gallery__title:focus-visible)').get('box-shadow')).toBe(
      'var(--ring)',
    );
  });
});

describe('the feed layout (slice 13d)', () => {
  it('draws each note as a row on line-soft, not a card', () => {
    const row = styleOf('.feed__card');
    expect(row.get('border-bottom')).toBe('1px solid var(--line-soft)');
    expect(row.has('background')).toBe(false);
    expect(row.has('box-shadow')).toBe(false);
    expect(row.has('border-radius')).toBe(false);
  });

  it('wraps a title with nothing to break at, as the gallery does, instead of overflowing the row', () => {
    const title = styleOf('.feed__title');
    expect(title.get('overflow-wrap')).toBe('anywhere');
    expect(title.get('max-width')).toBe('100%');
    expect(styleOf('.gallery__title-text').get('overflow-wrap')).toBe('anywhere');
  });

  it('divides a note’s fields from its body with line-soft', () => {
    expect(styleOf('.feed__body').get('border-top')).toBe('1px solid var(--line-soft)');
  });

  it('casts no shadow under "Show more notes": it is the secondary button', () => {
    expect(styleOf('.feed__more').has('box-shadow')).toBe(false);
    expect(styleOf('.feed__more').has('background')).toBe(false);
  });
});

describe('the done box and the Layout menu (slice 13d)', () => {
  it('draws the done box on the surface at an input’s radius, ticked in the done sage', () => {
    const box = styleOf('.done-check');
    expect(box.get('background')).toBe('var(--surface)');
    expect(box.get('border-radius')).toBe('var(--radius-control)');
    expect(styleOf('.done-check:checked').get('background')).toBe('var(--status-done-dot)');
  });

  it('quietens a layout the type cannot draw by its ink, not by opacity', () => {
    const disabled = styleOf('.layout-menu__item[data-disabled]');
    expect(disabled.get('color')).toBe('var(--ink-3)');
    expect(disabled.has('opacity')).toBe(false);
    expect(styleOf('.layout-menu__item').get('min-height')).toBe('28px');
  });

  it('keeps every weight in the layouts to 400, 500 or 600', () => {
    const layouts = /^\.(list-view|gallery|feed|card-cover|done-check|layout-menu)/;
    const heavy = rules
      .filter((rule) => rule.selectors.some((selector) => layouts.test(selector)))
      .map((rule) => ({ rule, weight: rule.declarations.get('font-weight') ?? null }))
      .filter(({ weight }) => weight !== null && !['400', '500', '600'].includes(weight))
      .map(({ rule, weight }) => `${rule.selectors.join(', ')} -> ${weight ?? ''}`);
    expect(heavy).toEqual([]);
  });
});

/** Each text run a layout draws, with the ground it is painted on. */
const TEXT_RUNS: readonly { run: string; ink: string; ground: string }[] = [
  { run: 'a list row’s title', ink: '--ink', ground: '--surface' },
  { run: 'a list row’s title under the pointer', ink: '--ink', ground: '--hover' },
  { run: 'a list row’s summary', ink: '--ink-3', ground: '--surface' },
  { run: 'a list row’s summary under the pointer', ink: '--ink-3', ground: '--hover' },
  { run: 'a gallery card’s title', ink: '--ink', ground: '--surface' },
  { run: 'a gallery card’s summary', ink: '--ink-3', ground: '--surface' },
  { run: 'a finished note’s struck title', ink: '--ink-3', ground: '--surface' },
  { run: 'a feed row’s title', ink: '--ink', ground: '--surface' },
  { run: 'a feed row’s stand-in summary', ink: '--ink-2', ground: '--surface' },
  { run: 'a feed body’s Show more', ink: '--accent-text', ground: '--surface' },
  { run: 'a feed body’s Show more under the pointer', ink: '--accent-text', ground: '--hover' },
  { run: 'Show more notes', ink: '--btn-secondary-ink', ground: '--btn-secondary-bg' },
  { run: 'a Layout menu row', ink: '--ink', ground: '--surface' },
  { run: 'a Layout menu row highlighted', ink: '--ink', ground: '--hover' },
  { run: 'a disabled layout and its reason', ink: '--ink-3', ground: '--surface' },
  { run: 'a disabled layout highlighted', ink: '--ink-3', ground: '--hover' },
];

/**
 * The non-text marks: a boundary or a state that has to read at 3:1 (WCAG
 * 1.4.11). A ticked box is told from an empty one by its fill; the tick glyph
 * inside it (`--status-done-tick`, slice 1's) is not what carries the state.
 */
const MARKS: readonly { mark: string; paint: string; ground: string }[] = [
  { mark: 'the done box’s line', paint: '--ink-3', ground: '--surface' },
  { mark: 'the done box’s line under the pointer', paint: '--ink-2', ground: '--surface' },
  { mark: 'a ticked done box', paint: '--status-done-dot', ground: '--surface' },
  { mark: 'the focus ring', paint: '--focus', ground: '--surface' },
];

describe.each(Object.entries(palettes))('contrast in the %s theme', (_name, theme) => {
  it.each(TEXT_RUNS)('$run clears AA (4.5:1)', ({ ink, ground }) => {
    expect(contrast(paint(theme, ink), paint(theme, ground))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARKS)('$mark clears 3:1', ({ paint: mark, ground }) => {
    expect(contrast(paint(theme, mark), paint(theme, ground))).toBeGreaterThanOrEqual(3);
  });

  it('the layouts’ inks are the ones measured here', () => {
    expect(styleOf('.list-view__summary').get('color')).toBe('var(--ink-3)');
    expect(styleOf('.feed__toggle').get('color')).toBe('var(--accent-text)');
    expect(styleOf('.layout-menu__reason').get('color')).toBe('var(--ink-3)');
    expect(styleOf('.done-check').get('border')).toBe('1.5px solid var(--ink-3)');
    expect(styleOf('.done-check:hover').get('border-color')).toBe('var(--ink-2)');
  });
});
