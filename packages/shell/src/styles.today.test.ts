import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Today page and the weekly review (UI v2 slice 13a, #310): the table
 * view's 34px rows under 15/600 section titles, a row's metadata on one
 * line with a · between the pieces; the last action is said in the
 * window's toasts (#320), not on a bar of the page's own. These hold what the restyle has to carry in both themes: every text
 * run at AA (WCAG 1.4.3) on the ground it sits on — the surface, a hovered
 * row, the well, a secondary control — and the rows' override gone, so the
 * list places them by the height the table draws.
 */

const sheet = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./styles/${file}`, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
const tokens = sheet('tokens.css');
const today = sheet('today.css');
const review = sheet('weekly-review.css');

/** The declarations of the first block whose selector starts with `opening`. */
function blockOf(source: string, opening: string): Map<string, string> {
  const start = source.indexOf(opening);
  if (start < 0) throw new Error(`no block ${opening}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  const declared = new Map<string, string>();
  for (const match of source.slice(open + 1, close).matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    declared.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return declared;
}

const aliases = blockOf(tokens, "[data-theme='light'],\n[data-theme='dark'] {");
const themes = {
  light: blockOf(tokens, ":root,\n[data-theme='light']"),
  dark: blockOf(tokens, "[data-theme='dark'] {"),
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

/** The one token a declaration reads. */
const tokenIn = (declaration: string | undefined) =>
  /var\((--[\w-]+)\)/.exec(declaration ?? '')?.[1] ?? '';

const link = blockOf(today, '.today__link {');
const linkWords = blockOf(today, '.today__link-words {');
const groupName = blockOf(today, '.today__group-name {');
const sep = blockOf(today, '.today__sep {');
const late = blockOf(today, '.today__late {');
const detail = blockOf(review, '.review__grid .review__detail {');
const count = blockOf(review, '.review__count {');
const status = blockOf(review, '.review__status {');

describe('the Today page and the weekly review', () => {
  it('leave the rows to the table view: no height of their own, so 34px is what the list places by', () => {
    expect(review).not.toMatch(/\.review__grid td\s*{/);
    expect(review).not.toContain('44px');
    expect(today).not.toContain('44px');
  });

  it('draw no undo bar of their own: the last action is the toast’s (#320)', () => {
    expect(today).not.toContain('.today__notice');
  });

  it('join the metadata with a · in the separator grey, and keep no chip per value', () => {
    expect(tokenIn(sep.get('color'))).toBe('--sep');
    expect(today).not.toContain('.today__context');
  });

  it('draw the elsewhere strip and Move to… as 6px secondary controls, not pills', () => {
    for (const control of [link, status]) {
      expect(tokenIn(control.get('border-radius'))).toBe('--radius-button');
      expect(tokenIn(control.get('background'))).toBe('--btn-secondary-bg');
      expect(control.has('box-shadow')).toBe(false);
    }
  });
});

describe.each(Object.entries(themes))('Today and review contrast, %s theme', (_name, theme) => {
  const on = (mark: string, ground: string) =>
    contrast(resolve(theme, mark), resolve(theme, ground));
  /** What a row's text sits on: the surface, and the hover fill under the pointer. */
  const rowGrounds = ['--surface', '--hover'] as const;

  it.each(rowGrounds)('a row’s metadata, in ink-2, clears AA on %s', (ground) => {
    expect(tokenIn(detail.get('color'))).toBe('--ink-2');
    expect(on('--ink-2', ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(rowGrounds)('an overdue day, in the danger red, clears AA on %s', (ground) => {
    expect(on(tokenIn(late.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('a group’s name, and the count beside a title, clear AA on the surface', () => {
    expect(on(tokenIn(groupName.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(count.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
  });

  it('the elsewhere strip’s words and Move to… clear AA on the secondary control', () => {
    const ground = tokenIn(link.get('background'));
    expect(on(tokenIn(link.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(linkWords.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    expect(
      on(tokenIn(status.get('color')), tokenIn(status.get('background'))),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
