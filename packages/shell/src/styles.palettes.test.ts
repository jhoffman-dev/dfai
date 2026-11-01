import { describe, expect, it } from 'vitest';
import { readStylesheet } from './styles.test-support.ts';

/**
 * The palettes (UI v2, slice 13e): ⌘K search and ⇧⌘N capture. Each is a popover by
 * `Tokens.dc.html`'s rules — radius 8, the popover shadow, a hairline — with
 * 36px rows, the `selected` fill on the chosen row and keys as plain ink-3
 * text. These hold what that has to carry: the chosen row's words, including
 * its metadata and its ↵, at AA on the `selected` fill (#273), and the key
 * hints at AA on the surface.
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

/** A theme's tokens, as its declarations. */
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
const themes = {
  light: paletteOf(":root,\n[data-theme='light']"),
  dark: paletteOf("[data-theme='dark'] {"),
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

/** The first token a declaration reads. */
const tokenIn = (declaration: string | undefined) =>
  /var\((--[\w-]+)\)/.exec(declaration ?? '')?.[1] ?? '';

describe('.palette is a popover by the Tokens board', () => {
  const popover = styleOf('.palette');

  it('has the popover radius, the popover shadow and a hairline', () => {
    expect(popover.get('border-radius')).toBe('var(--radius-popover)');
    expect(popover.get('box-shadow')).toBe('var(--shadow-popover)');
    expect(popover.get('border')).toBe('1px solid var(--line)');
    expect(popover.get('background')).toBe('var(--surface)');
  });
});

describe('a palette row', () => {
  const row = styleOf('.palette__hit');
  const chosen = styleOf('.palette__hit--on');

  // A command row is one line and sits at the 36px minimum; a hit keeps its
  // two lines (the title, then the place and the snippet) and is taller.
  it('is 36px when it is one line, and takes the hover fill under the pointer', () => {
    expect(row.get('min-height')).toBe('36px');
    expect(row.has('height')).toBe(false);
    expect(styleOf('.palette__text').get('display')).toBe('grid');
    expect(styleOf('.palette__hit:hover').get('background')).toBe('var(--hover)');
  });

  it('wears the selected fill when chosen, not the accent', () => {
    expect(chosen.get('background')).toBe('var(--selected)');
  });

  it('lifts its metadata and its ↵ to ink-2 when chosen, where ink-3 falls under AA', () => {
    expect(tokenIn(styleOf('.palette__hit--on .palette__detail').get('color'))).toBe('--ink-2');
    expect(tokenIn(styleOf('.palette__hit--on .key').get('color'))).toBe('--ink-2');
  });
});

describe('a key hint', () => {
  const key = styleOf('.key');

  it('is plain ink-3 text at the header size, with no box around it', () => {
    expect(tokenIn(key.get('color'))).toBe('--ink-3');
    expect(key.get('font-size')).toBe('var(--text-header)');
    expect(key.has('border')).toBe(false);
    expect(key.has('background')).toBe(false);
    expect(key.has('box-shadow')).toBe(false);
  });
});

describe.each(Object.entries(themes))('palette contrast, %s theme', (_name, theme) => {
  const on = (mark: string, ground: string) =>
    contrast(resolve(theme, mark), resolve(theme, ground));

  it('the chosen row: its title, its metadata, its ↵ and its matched words clear AA on the selected fill', () => {
    expect(on('--ink', '--selected')).toBeGreaterThanOrEqual(4.5);
    expect(on('--ink-2', '--selected')).toBeGreaterThanOrEqual(4.5);
    expect(on('--accent-text', '--selected')).toBeGreaterThanOrEqual(4.5);
  });

  it('a row at rest and under the pointer: its ink-3 metadata clears AA', () => {
    expect(on('--ink-3', '--surface')).toBeGreaterThanOrEqual(4.5);
    expect(on('--ink-3', '--hover')).toBeGreaterThanOrEqual(4.5);
  });

  it('the key hints along the foot clear AA on the surface', () => {
    expect(on(tokenIn(styleOf('.key').get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
  });

  it("the capture palette's destination chip clears AA", () => {
    const chip = styleOf('.palette__destination');
    expect(on(tokenIn(chip.get('color')), tokenIn(chip.get('background')))).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
