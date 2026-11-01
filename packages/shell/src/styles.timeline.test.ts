import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The timeline's Gantt bars (UI v2, after slice 13c): a bar's length is the
 * data, so its end has to be seen. The bar wore the pressed-toggle fill
 * (`--selected`) at 1.2:1 on the surface, and the end of a bar was a guess; it
 * now wears the dashboard's chart grey. These hold what that grey has to carry:
 * the fill at 3:1 on the surface (WCAG 1.4.11), the title on it at 4.5:1
 * (1.4.3), every status edge at 3:1 against the surface it is parted from the
 * fill by, and the today line at 3:1 where it crosses a bar.
 */

const sheet = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./styles/${file}`, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
const tokens = sheet('tokens.css');
const timeline = sheet('timeline.css');

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

/** Every token a declaration reads, in order. */
const tokensIn = (declaration: string) =>
  [...declaration.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1] ?? '');

const bar = blockOf(timeline, '.timeline__bar {');
const today = blockOf(timeline, '.timeline__today {');
const hover = blockOf(timeline, '.timeline__bar:hover {');
const critical = blockOf(timeline, '.timeline__bar.timeline__bar--critical {');

/** What the bar is painted with: the last colour its background names. */
const fill = tokensIn(bar.get('background') ?? '').at(-1) ?? '';
/** The 1px of surface between the status edge and the fill. */
const gap = tokensIn(bar.get('background') ?? '')[0] ?? '';
const labelInk = tokensIn(bar.get('color') ?? '')[0] ?? '';

const STATUSES = ['backlog', 'inbox', 'next', 'doing', 'waiting', 'review', 'done'] as const;

/** The edge token a status gives `--bar-edge`. */
function edgeOf(status: (typeof STATUSES)[number]): string {
  const rule = blockOf(timeline, `.timeline__bar[data-tone='${status}'] {`);
  return tokensIn(rule.get('--bar-edge') ?? '')[0] ?? '';
}

describe('the Gantt bar', () => {
  it('is filled with the chart grey, not the pressed-toggle fill', () => {
    expect(fill).toBe('--chart-bar');
    expect(bar.get('background')).not.toContain('--selected');
  });

  it('parts its status edge from the fill with 1px of surface', () => {
    expect(gap).toBe('--surface');
    expect(bar.get('background')).toMatch(/var\(--surface\) 1px, var\(--chart-bar\) 1px/);
  });

  it('keeps its fill under the pointer, so its end stays where it was', () => {
    expect(hover.has('background')).toBe(false);
  });
});

describe.each(Object.entries(themes))('Gantt bar contrast, %s theme', (_name, theme) => {
  const on = (mark: string, ground: string) =>
    contrast(resolve(theme, mark), resolve(theme, ground));

  it('the fill holds 3:1 against the surface, so the end of a bar can be seen', () => {
    expect(on(fill, '--surface')).toBeGreaterThanOrEqual(3);
  });

  it('the title on the fill clears AA (4.5:1)', () => {
    expect(on(labelInk, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUSES)('the %s edge holds 3:1 against the surface it is parted by', (status) => {
    expect(on(edgeOf(status), gap)).toBeGreaterThanOrEqual(3);
  });

  it('the critical chain edge is the danger red, at 3:1 against the surface it is parted by', () => {
    const edge = tokensIn(critical.get('--bar-edge') ?? '')[0] ?? '';
    expect(edge).toBe('--danger');
    expect(on(edge, gap)).toBeGreaterThanOrEqual(3);
  });

  it('the today line holds 3:1 where it crosses a bar, and against the surface', () => {
    const ink = tokensIn(today.get('background') ?? '')[0] ?? '';
    expect(on(ink, fill)).toBeGreaterThanOrEqual(3);
    expect(on(ink, '--surface')).toBeGreaterThanOrEqual(3);
  });
});
