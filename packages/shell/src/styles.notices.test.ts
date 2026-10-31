import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * UI v2 slice 13j (#319): every notice, offer and migration banner is the
 * one notice bar — a line on the well under a hairline, 40px tall, never a
 * tinted card. This holds the bar to that, and holds every ink drawn on the
 * well — the words, the ink-3 explanation, the warning icon, a ghost verb —
 * at AA (4.5:1) in both themes, with the secondary verb on its own fill.
 */

const css = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./styles/${file}`, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
const tokens = css('tokens.css');
const primitives = css('primitives.css');
/** The section files that drew the eight banners as cards before #319. */
const SECTIONS = ['inbox.css', 'gtd.css', 'board.css', 'terms.css', 'templates.css'];
/** The bar itself, and the eight banners by the class each still goes by. */
const BANNERS = [
  '.notice-bar',
  '.inbox__offer',
  '.task-migration',
  '.vault-tidy',
  '.meeting-cleanup',
  '.promotion-notice',
  '.corrections-band',
  '.template-banner',
];

/** The declarations of the first block whose selector starts with `opening`. */
function blockOf(sheet: string, opening: string): Map<string, string> {
  const start = sheet.indexOf(opening);
  if (start < 0) throw new Error(`no block ${opening}`);
  const open = sheet.indexOf('{', start);
  const close = sheet.indexOf('}', open);
  const declared = new Map<string, string>();
  for (const match of sheet.slice(open + 1, close).matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    declared.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return declared;
}

const aliases = blockOf(tokens, "[data-theme='light'],\n[data-theme='dark'] {");
const themes = {
  light: blockOf(tokens, ":root,\n[data-theme='light']"),
  dark: blockOf(tokens, "[data-theme='dark'] {"),
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

/** A token as the colour on screen: a hex as is, an rgba() laid over the well. */
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
  const under = paint(theme, '--well');
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

/** Every rule of a stylesheet as its selector and its declarations. */
function rules(sheet: string): { selector: string; declarations: string }[] {
  return [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').replace(/\s+/g, ' ').trim(),
    declarations: match[2] ?? '',
  }));
}

/** Whether a selector names this class as a whole: `.notice-bar`, not `.notice-bar--open`. */
const names = (selector: string, className: string) =>
  new RegExp(`${className.replace(/[.$^*+?()[\]{}|\\]/g, '\\$&')}(?![\\w-])`).test(selector);

/** What is drawn on the well, and the ink each is drawn in. */
const ON_THE_WELL = {
  'the words': '--ink',
  'the ink-3 explanation': '--ink-3',
  'the icon': '--ink-3',
  'the warning icon': '--warning',
  'a ghost verb': '--btn-ghost-ink',
  'a refusal': '--warning',
};

describe.each(Object.entries(themes))('the notice bar, %s theme', (_name, theme) => {
  it.each(Object.entries(ON_THE_WELL))('%s clears AA (4.5:1) on the well', (_what, ink) => {
    expect(contrast(paint(theme, ink), paint(theme, '--well'))).toBeGreaterThanOrEqual(4.5);
  });

  it('the secondary verb clears AA on its own fill, and its fill is told from the well by its line', () => {
    expect(
      contrast(paint(theme, '--btn-secondary-ink'), paint(theme, '--btn-secondary-bg')),
    ).toBeGreaterThanOrEqual(4.5);
    expect(rawValue(theme, '--btn-secondary-line')).not.toBe(rawValue(theme, '--well'));
  });
});

describe('the notice bar is drawn once, in primitives.css', () => {
  const bar = blockOf(primitives, '.notice-bar {');

  it('is a line on the well under a hairline, 40px tall, with its icon and explanation in ink-3', () => {
    expect(bar.get('background')).toBe('var(--well)');
    expect(bar.get('border-bottom')).toBe('1px solid var(--line)');
    expect(bar.get('min-height')).toBe('40px');
    expect(bar.get('color')).toBe('var(--ink)');
    expect(bar.has('border-radius')).toBe(false);
    expect(bar.has('box-shadow')).toBe(false);
    expect(blockOf(primitives, '.notice-bar__icon {').get('color')).toBe('var(--ink-3)');
    expect(blockOf(primitives, '.notice-bar__text small,').get('color')).toBe('var(--ink-3)');
  });

  it('no banner draws a tint, a radius or a shadow of its own any more', () => {
    for (const file of SECTIONS) {
      for (const rule of rules(css(file))) {
        if (!BANNERS.some((banner) => names(rule.selector, banner))) continue;
        expect(rule.declarations, `${file}: ${rule.selector}`).not.toMatch(
          /background|border-radius|box-shadow|color-mix/,
        );
      }
    }
  });
});
