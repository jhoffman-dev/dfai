import { PILL_HUES } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { readStylesheet } from './styles.test-support.ts';

/**
 * The pill hues (#413): the muted pastels an option that is not a status, a
 * linked note and a tag are drawn in, so the eye finds them again. Each ink
 * has to read on its own fill at AA — 4.5:1 — in light, in the dark the app
 * chose and in the dark the system asked for, and each fill has to stay a
 * pastel: a fill loud enough to shout would undo the calm the hues are for.
 * The list of hues is the domain's, so a hue added there without its colours
 * fails here.
 */

const css = readStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');

/** A theme's tokens: the declarations of the first block that opens with `opening`. */
function paletteOf(opening: string): Map<string, string> {
  const start = css.indexOf(opening);
  if (start < 0) throw new Error(`no palette ${opening}`);
  const open = css.indexOf('{', start + opening.length - 1);
  const body = css.slice(open + 1, css.indexOf('}', open));
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
  );
}

const THEMES = {
  light: paletteOf(":root,\n[data-theme='light'] {"),
  'chosen dark': paletteOf("[data-theme='dark'] {"),
  'system dark': paletteOf(":root:not([data-theme='light']) {"),
} as const;

function hexOf(theme: Map<string, string>, token: string): string {
  const value = theme.get(token);
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${token} is not a hex colour (${String(value)})`);
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

/** A colour in CIELAB (D65), for how far apart two fills look. */
function lab(hex: string): [number, number, number] {
  const linear = [1, 3, 5].map((at) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = linear;
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 ΔE: about 2 is a just-visible step; 10 is two colours told apart at a glance. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** How far a colour is from grey: the spread of its channels, 0–255. */
function chroma(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return Math.max(...channels) - Math.min(...channels);
}

const cases = Object.entries(THEMES).flatMap(([theme, tokens]) =>
  PILL_HUES.map((hue) => ({ theme, tokens, hue })),
);

describe('the pill hues', () => {
  it('are nine, as the domain lists them', () => {
    expect(PILL_HUES).toHaveLength(9);
  });

  it.each(cases)('$hue reads at AA on its own fill in $theme', ({ tokens, hue }) => {
    const ratio = contrast(hexOf(tokens, `--hue-${hue}-ink`), hexOf(tokens, `--hue-${hue}-bg`));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it.each(cases)('$hue keeps a muted fill in $theme', ({ tokens, hue }) => {
    // A pastel: low in chroma. Notion's own fills spread up to 53 (its
    // yellow); a saturated chip would be well past 80.
    expect(chroma(hexOf(tokens, `--hue-${hue}-bg`))).toBeLessThanOrEqual(55);
  });

  it.each(cases)(
    '$hue fill stays a quiet ground, not a block of colour, in $theme',
    ({ theme, tokens, hue }) => {
      const surface = hexOf(tokens, '--surface');
      const fill = hexOf(tokens, `--hue-${hue}-bg`);
      // Close enough to the surface to read as a tint; the ink carries the words.
      expect(contrast(fill, surface), `${theme} ${hue}`).toBeLessThan(1.6);
    },
  );

  it.each(Object.keys(THEMES))('keeps every two fills apart at a glance in %s', (theme) => {
    const tokens = THEMES[theme as keyof typeof THEMES];
    const close = PILL_HUES.flatMap((hue, at) =>
      PILL_HUES.slice(at + 1)
        .map((other) => ({
          pair: `${hue}/${other}`,
          apart: deltaE(hexOf(tokens, `--hue-${hue}-bg`), hexOf(tokens, `--hue-${other}-bg`)),
        }))
        .filter(({ apart }) => apart < 10)
        .map(({ pair, apart }) => `${pair} ΔE ${apart.toFixed(1)}`),
    );
    expect(close).toEqual([]);
  });

  it.each(PILL_HUES)('paints a %s pill from its own tokens', (hue) => {
    const rule = new RegExp(
      String.raw`\[data-hue='${hue}'\]\s*\{[^}]*--pill:\s*var\(--hue-${hue}-bg\);[^}]*--pill-ink:\s*var\(--hue-${hue}-ink\);`,
    );
    expect(css).toMatch(rule);
  });
});
