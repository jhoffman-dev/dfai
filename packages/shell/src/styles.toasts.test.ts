import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPINNER_DELAY_MS } from '@dfai/ui';

/**
 * The window's toasts (#320): a dark surface in both themes whose words
 * clear AA (WCAG 1.4.3) and whose dot — the tone of what it says — clears
 * the 3:1 a graphic needs (1.4.11) in a muted hue, never grey; several in
 * one column that lets the pointer through where no toast is; and the
 * delayed spinner, which stills for reduced motion.
 */
const sheet = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./styles/${file}`, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
const tokens = sheet('tokens.css');
const primitives = sheet('primitives.css');

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

const themes = {
  light: blockOf(tokens, ":root,\n[data-theme='light']"),
  dark: blockOf(tokens, "[data-theme='dark'] {"),
};

const hex = (theme: Map<string, string>, name: string) => {
  const value = theme.get(name) ?? '';
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a hex colour: ${value}`);
  return value;
};
const channel = (colour: string, at: number) => {
  const value = Number.parseInt(colour.slice(at, at + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (colour: string) =>
  0.2126 * channel(colour, 1) + 0.7152 * channel(colour, 3) + 0.0722 * channel(colour, 5);
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}
/** How far a colour is from grey: its widest gap between two channels. */
const chroma = (colour: string) => {
  const parts = [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));
  return Math.max(...parts) - Math.min(...parts);
};
const tokenIn = (declaration: string | undefined) =>
  /var\((--[\w-]+)\)/.exec(declaration ?? '')?.[1] ?? '';

const DOTS = ['change', 'warning', 'error'] as const;

describe.each(Object.entries(themes))('a toast, %s theme', (_name, theme) => {
  const ground = hex(theme, '--toast-bg');

  it('says its words, and its dismiss, at AA on its dark surface', () => {
    expect(contrast(hex(theme, '--toast-ink'), ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(theme, '--toast-ink-2'), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(DOTS)('draws the %s dot in a muted hue, not grey, at 3:1 on the surface', (tone) => {
    const dot = blockOf(primitives, `.toast__dot--${tone} {`);
    const colour = hex(theme, tokenIn(dot.get('background')));
    expect(contrast(colour, ground)).toBeGreaterThanOrEqual(3);
    expect(chroma(colour)).toBeGreaterThan(30);
  });

  it('tells its three tones apart', () => {
    const colours = DOTS.map((tone) =>
      hex(theme, tokenIn(blockOf(primitives, `.toast__dot--${tone} {`).get('background'))),
    );
    expect(new Set(colours).size).toBe(3);
  });
});

describe('the toast column', () => {
  const stack = blockOf(primitives, '.toast-stack {');
  const inStack = blockOf(primitives, '.toast-stack > .toast {');

  it('stacks its toasts in one column at the toast’s corner, letting the pointer through between them', () => {
    expect(stack.get('position')).toBe('absolute');
    expect(stack.get('flex-direction')).toBe('column');
    expect(stack.get('pointer-events')).toBe('none');
    expect(inStack.get('pointer-events')).toBe('auto');
    expect(inStack.get('position')).toBe('static');
    expect(stack.get('bottom')).toBe(blockOf(primitives, '.toast {').get('bottom'));
  });
});

describe('the delayed spinner', () => {
  const ring = blockOf(primitives, '.spinner__ring {');

  it('holds its ring hidden for SPINNER_DELAY_MS, then shows it and turns', () => {
    expect(ring.get('opacity')).toBe('0');
    const animation = ring.get('animation') ?? '';
    expect(animation).toContain(`spinner-shown 0s linear ${SPINNER_DELAY_MS}ms forwards`);
    expect(animation).toContain(`spinner-turn 0.9s linear ${SPINNER_DELAY_MS}ms infinite`);
    expect(blockOf(primitives, '@keyframes spinner-shown {')).toBeDefined();
  });

  it('still waits, but does not turn, for reduced motion', () => {
    const still = primitives.slice(primitives.lastIndexOf('prefers-reduced-motion'));
    expect(blockOf(still, '.spinner__ring {').get('animation')).toBe(
      `spinner-shown 0s linear ${SPINNER_DELAY_MS}ms forwards`,
    );
  });

  it('holds the ring’s place before it shows, so nothing moves as it appears', () => {
    expect(blockOf(primitives, '.spinner {').get('min-height')).toBe(
      'calc(14px + 2 * var(--space-3))',
    );
  });
});

describe('the toasts among the layers (#468)', () => {
  const peek = sheet('peek.css');
  const menus = sheet('menus.css');
  const overlays = sheet('overlays.css');
  const dashboards = sheet('dashboard-editing.css');
  const layer = (source: string, opening: string) =>
    Number(blockOf(source, opening).get('z-index') ?? Number.NaN);
  const toasts = layer(primitives, '.toast-stack {');

  // In the window they sit under every layer a person works in, so none of
  // that layer's controls is hidden by one (review, attack-468).
  it('draws them under menus, palettes, dialogs and the peek', () => {
    expect(layer(primitives, '.toast {')).toBe(toasts);
    for (const over of [
      layer(menus, '.menu-positioner {'),
      layer(overlays, '.palette__backdrop {'),
      layer(dashboards, '.widget-sheet__backdrop {'),
      layer(peek, '.peek__viewport {'),
      layer(peek, '.peek__scrim {'),
    ]) {
      expect(toasts).toBeLessThan(over);
    }
  });

  // While the peek is up they are drawn in it — in its focus trap, so Tab
  // reaches their Undo — at the window's corner, over its own content.
  it('places them, inside the peek, at the window’s corner over the note', () => {
    const inPeek = blockOf(peek, '.peek__toasts .toast-stack {');
    expect(inPeek.get('position')).toBe('fixed');
    expect(Number(inPeek.get('z-index'))).toBeGreaterThan(0);
  });
});
