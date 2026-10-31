import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Issue #369: the done box's tick (`--status-done-tick`) is drawn on the
 * done dot (`--status-done-dot`, reached as `--navy-data`) by the table,
 * the board and the list and feed layouts. In dark the white tick measured
 * 2.15:1 on the sage fill, under the 3:1 bar for a non-text mark (WCAG
 * 1.4.11). The fill carries the state against the surface, so it stays;
 * the tick must read on it in every palette, including the system-dark one
 * inside the media query, which the chosen-dark block does not cover.
 */

const css = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./styles/${file}`, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
const tokens = css('tokens.css');
const layouts = css('layouts.css');

/** The declarations of the first block whose selector starts with `opening`. */
function blockOf(opening: string): Map<string, string> {
  const start = tokens.indexOf(opening);
  if (start < 0) throw new Error(`no block ${opening}`);
  const open = tokens.indexOf('{', start);
  const close = tokens.indexOf('}', open);
  const declared = new Map<string, string>();
  for (const match of tokens.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declared.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return declared;
}

const aliases = blockOf("[data-theme='light'],\n[data-theme='dark'] {");
const themes = {
  light: blockOf(":root,\n[data-theme='light']"),
  'system dark': blockOf(":root:not([data-theme='light'])"),
  dark: blockOf("[data-theme='dark'] {"),
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

/** The declarations of the first rule in `sheet` whose selector is exactly `selector`. */
function declarationsOf(sheet: string, selector: string): string {
  for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? '').replace(/\s+/g, ' ').trim() === selector) return match[2] ?? '';
  }
  throw new Error(`no rule ${selector}`);
}

/**
 * The token the done box fills with when ticked: `--navy-data` before slice
 * 13d, `--status-done-dot` after. Both are the done dot, so the test reads
 * whichever the rule names and resolves it, rather than naming one.
 */
function fillOfDoneBox(): string {
  const fill = /background:\s*var\((--[\w-]+)\)/.exec(
    declarationsOf(layouts, '.done-check:checked'),
  );
  if (fill === null) throw new Error('.done-check:checked does not fill with a token');
  return fill[1] ?? '';
}

it('the done box fills with a token and draws its tick in --status-done-tick', () => {
  expect(fillOfDoneBox()).toMatch(/^--[\w-]+$/);
  expect(declarationsOf(layouts, '.done-check:checked::after')).toMatch(
    /border:\s*solid var\(--status-done-tick\)/,
  );
});

describe.each(Object.entries(themes))('the done box, %s theme', (_name, theme) => {
  it('fills with the done dot', () => {
    expect(paint(theme, fillOfDoneBox())).toEqual(paint(theme, '--status-done-dot'));
  });

  it('draws its tick at 3:1 or better on the done dot (WCAG 1.4.11)', () => {
    expect(
      contrast(paint(theme, '--status-done-tick'), paint(theme, '--status-done-dot')),
    ).toBeGreaterThanOrEqual(3);
  });

  it('draws its tick at 3:1 or better on the fill it actually paints', () => {
    expect(
      contrast(paint(theme, '--status-done-tick'), paint(theme, fillOfDoneBox())),
    ).toBeGreaterThanOrEqual(3);
  });

  it('keeps the fill carrying the state at 3:1 or better on the surface', () => {
    expect(
      contrast(paint(theme, '--status-done-dot'), paint(theme, '--surface')),
    ).toBeGreaterThanOrEqual(3);
  });
});
