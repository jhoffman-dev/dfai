import { describe, expect, it } from 'vitest';
import { readStylesheet } from './styles.test-support.ts';

/**
 * A highlight drawn in the editor (#534): its words on the mark's fill, and
 * its rule and underline in the mark's edge. In light and in both darks the
 * words' ink has to read on the fill at AA — 4.5:1 — and the rule and the
 * underline against the page at 3:1, with the fills kept as the muted
 * pastels the reader uses: only how much of one shows, and which line, change.
 */

const css = readStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
const COLOURS = ['yellow', 'green', 'blue', 'pink', 'purple', 'orange'] as const;

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

/** A token's value, `var()` followed to the hex it names. */
function resolved(theme: Map<string, string>, token: string): string {
  const value = theme.get(token);
  if (value === undefined) throw new Error(`${token} is not set`);
  const named = /^var\((--[\w-]+)\)$/.exec(value);
  return named === null ? value : resolved(theme, named[1] ?? '');
}

const rgb = (hex: string): [number, number, number] => {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`${hex} is not a hex colour`);
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
};
const luminanceOf = ([r, g, b]: [number, number, number]) => {
  const linear = [r, g, b].map((value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
};
function contrast(one: [number, number, number], other: [number, number, number]): number {
  const [light = 0, dark = 0] = [luminanceOf(one), luminanceOf(other)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
/** `fill` at `percent` over `ground`: what `color-mix(in srgb, fill percent, transparent)` shows. */
const over = (fill: string, percent: number, ground: string): [number, number, number] => {
  const [a, b] = [rgb(fill), rgb(ground)];
  return a.map((value, at) =>
    Math.round((value * percent) / 100 + (b[at] ?? 0) * (1 - percent / 100)),
  ) as [number, number, number];
};

describe.each(Object.entries(THEMES))('a highlight in the editor, %s', (_name, theme) => {
  const mix = Number.parseFloat(resolved(theme, '--highlight-mix'));
  const surface = resolved(theme, '--surface');

  it.each(COLOURS)('keeps the words of a %s highlight at 4.5:1 on its fill', (colour) => {
    const fill = over(resolved(theme, `--mark-${colour}`), mix, surface);
    expect(contrast(rgb(resolved(theme, '--ink')), fill)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(COLOURS)(
    'keeps the rule and underline of a %s highlight at 3:1 on the page',
    (colour) => {
      expect(
        contrast(rgb(resolved(theme, `--mark-${colour}-edge`)), rgb(surface)),
      ).toBeGreaterThanOrEqual(3);
    },
  );

  it("keeps a comment's words at 4.5:1 on the page", () => {
    expect(contrast(rgb(resolved(theme, '--ink-2')), rgb(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(COLOURS)('keeps the %s fill the muted pastel the reader uses', (colour) => {
    const [r, g, b] = rgb(resolved(theme, `--mark-${colour}`));
    // Pastels are light and not saturated to the full: the same fills in every theme.
    expect(Math.min(r, g, b)).toBeGreaterThanOrEqual(0x8a);
  });
});

describe('the editor draws a highlight with those tokens', () => {
  it('uses the edge for the rule and underline and the mix for the fill', () => {
    expect(css).toMatch(/border-left:\s*3px solid var\(--highlight-line\)/);
    expect(css).toMatch(/text-decoration:\s*underline 2px var\(--highlight-line\)/);
    expect(css).toMatch(/var\(--highlight-fill\) var\(--highlight-mix\)/);
  });
});

/*
 * Verification pass 2 on ba80bef2: an empty comment field reads "Add a
 * comment", the only words a highlight without a comment shows under it. With
 * no `::placeholder` rule of its own (every other field here has one) it is
 * drawn in WebKit's default grey, about 2.3:1 on the light page.
 */
describe.each(Object.entries(THEMES))('an empty comment field, %s', (_name, theme) => {
  it('draws "Add a comment" in a token at 4.5:1 on the page', () => {
    const rule = /\.highlight-quote__input::placeholder\s*\{([^}]*)\}/.exec(css);
    const token = /color:\s*var\((--[\w-]+)\)/.exec(rule?.[1] ?? '')?.[1];
    expect(token, 'the comment field styles its placeholder').toBeDefined();
    const ink = rgb(resolved(theme, token ?? ''));
    expect(contrast(ink, rgb(resolved(theme, '--surface')))).toBeGreaterThanOrEqual(4.5);
  });
});
