import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Review of PR #357 (UI v2 slice 13i, the chat): a proposed change draws the
 * note's blocks on the Done tint (added) and the Reject tint (removed). In
 * dark both tints are a colour at 16% over the surface, and the editor's
 * ink-3 metadata — a bookmark's site, an embed's source — falls under 4.5:1
 * on them. chat.css lifts that metadata to ink-2 inside a diff block; this
 * holds it there, in both themes, on both tints.
 */

const css = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./styles/${file}`, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
const tokens = css('tokens.css');
const chat = css('chat.css');
const editor = css('editor.css');

/** The metadata the editor draws in ink-3 that a block in a diff can carry. */
const METADATA = ['.bookmark__place', '.block-embed__source', '.block-embed__note'];
const BLOCKS = {
  added: { block: '.chat-proposal__block--added', tint: '--status-done-tint' },
  removed: { block: '.chat-proposal__block--removed', tint: '--btn-destructive-bg' },
};

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

/** Every rule of a stylesheet as its selector and its declarations. */
function rules(sheet: string): { selector: string; declarations: string }[] {
  return [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').replace(/\s+/g, ' ').trim(),
    declarations: match[2] ?? '',
  }));
}

/** Whether a selector names this class as a whole: `.note`, not `.note--warn`. */
const names = (selector: string, className: string) =>
  new RegExp(`${className.replace(/[.$^*+?()[\]{}|\\]/g, '\\$&')}(?![\\w-])`).test(selector);

/** The `color` token a stylesheet's rule gives `selector` under `scope`, if one does. */
function inkOf(sheet: string, scope: string, selector: string): string | null {
  let ink: string | null = null;
  for (const rule of rules(sheet)) {
    if (!names(rule.selector, scope) || !names(rule.selector, selector)) continue;
    const color = /(?:^|;|\s)color\s*:\s*var\((--[\w-]+)\)/.exec(rule.declarations);
    if (color !== null) ink = color[1] ?? null;
  }
  return ink;
}

/** What the metadata is drawn in inside a diff block: chat.css's say, else the editor's. */
function inkInside(block: string, metadata: string): string {
  const ink = inkOf(chat, block, metadata) ?? inkOf(editor, metadata, metadata);
  if (ink === null) throw new Error(`no colour for ${metadata}`);
  return ink;
}

describe.each(Object.entries(themes))('metadata in a proposed change, %s theme', (_name, theme) => {
  describe.each(Object.entries(BLOCKS))('in a %s block', (_kind, { block, tint }) => {
    it.each(METADATA)('%s clears AA (4.5:1) on the tint', (metadata) => {
      const ink = inkInside(block, metadata);
      expect(contrast(paint(theme, ink), paint(theme, tint))).toBeGreaterThanOrEqual(4.5);
    });
  });
});

it('the editor still draws that metadata in ink-3 elsewhere, so the diff rule is the one lifting it', () => {
  for (const metadata of METADATA) expect(inkOf(editor, metadata, metadata)).toBe('--ink-3');
});
