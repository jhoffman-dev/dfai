import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Attack on PR #336 (UI v2 slice 10, the dashboard): do the chart marks and
 * the dashboard's text hold their contrast against the panel they sit on, in
 * both themes? WCAG 1.4.11 asks 3:1 of a graphic a reader needs; 1.4.3 asks
 * 4.5:1 of small text. The bars are compared by height and most carry no
 * written value, so the bar itself is the information.
 */

const tokens = readFileSync(
  fileURLToPath(new URL('./styles/tokens.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

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
  dark: blockOf("[data-theme='dark'] {"),
};

function resolve(theme: Map<string, string>, name: string): string {
  let value = theme.get(name) ?? aliases.get(name);
  for (let hops = 0; value?.startsWith('var(') === true && hops < 10; hops += 1) {
    const next = value.slice(4, -1).trim();
    value = theme.get(next) ?? aliases.get(next);
  }
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} does not resolve to a hex colour (${String(value)})`);
  }
  return value;
}

const channel = (hex: string, at: number) => {
  const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) =>
  0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe.each(Object.entries(themes))('dashboard contrast, %s theme', (_name, theme) => {
  const on = (mark: string, ground = '--panel') =>
    contrast(resolve(theme, mark), resolve(theme, ground));

  it('a plain bar (--chart-bar) holds 3:1 against the panel it stands on', () => {
    expect(on('--chart-bar')).toBeGreaterThanOrEqual(3);
  });

  it('the called-out bar (--accent-data) holds 3:1 against the panel', () => {
    expect(on('--accent-data')).toBeGreaterThanOrEqual(3);
  });

  it('the first donut segment (--navy-data) holds 3:1 against the panel', () => {
    expect(on('--navy-data')).toBeGreaterThanOrEqual(3);
  });

  it('the rest of the hero status bar (--chart-track) is visible against the panel at 3:1', () => {
    // Without it the done part has no whole to be read against: 30% and 100%
    // draw as a blue line of a different length and nothing else. The bar's
    // rest is `--chart-track`: `--track` is the well tint thirty other rules
    // sit text on, and cannot be a 3:1 grey.
    expect(on('--chart-track')).toBeGreaterThanOrEqual(3);
  });

  it('axis ticks, labels and notes (--ink-3) hold 4.5:1 against the panel', () => {
    expect(on('--ink-3')).toBeGreaterThanOrEqual(4.5);
  });

  it('a bar value (--ink-2) holds 4.5:1 against the panel', () => {
    expect(on('--ink-2')).toBeGreaterThanOrEqual(4.5);
  });
});
