import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readStylesheet } from './styles.test-support.ts';

/**
 * Attack on UI v2 slice 13h (#317, the editor and note body restyle). Two
 * things the slice's own sheet test does not ask:
 *
 * - contrast in the states a row or cell is drawn in, not only at rest: the
 *   metadata ink (`--ink-3`) over the selected fill and over a cell
 *   selection's focus tint, in both themes (WCAG 1.4.3, 4.5:1 for text);
 * - the cascade between a state's border and the hover's border: a broken
 *   block embed now says so with its border alone, so a hover rule that wins
 *   over it hides the one sign it is broken.
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

const rgbOf = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));

/** `color-mix(in srgb, tint share%, ground)`, as the browser mixes it. */
function mix(tint: string, share: number, ground: string): string {
  const [a, b] = [rgbOf(tint), rgbOf(ground)];
  const mixed = a.map((value, at) => Math.round(value * share + (b[at] ?? 0) * (1 - share)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

const channel = (value: number) => {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = rgbOf(hex).map(channel);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe.each(Object.entries(themes))(
  'note body contrast in its states, %s theme',
  (_name, theme) => {
    const hex = (name: string) => resolve(theme, name);

    it('a selected suggestion keeps its path (ink-2 on --selected) at 4.5:1', () => {
      // `.suggest-option--on` fills the row with --selected, where --ink-3 at
      // 12px fell to 4.32:1 in light (dark held 4.64); `.suggest-option--on .suggest-option__path`
      // steps the path up to --ink-2. The selected row is the one being read.
      expect(contrast(hex('--ink-2'), hex('--selected'))).toBeGreaterThanOrEqual(4.5);
    });

    it('a header cell inside a cell selection keeps its label at 4.5:1', () => {
      // `.editor th` is --ink-3 on --well, which `.selectedCell::after`'s 16%
      // wash of --focus takes under AA; `.editor th.selectedCell` steps the
      // label up to --ink-2 for as long as the cell is chosen.
      const ground = mix(hex('--focus'), 0.16, hex('--well'));
      expect(contrast(hex('--ink-2'), ground)).toBeGreaterThanOrEqual(4.5);
    });

    it('inline code (code-ink on code-bg) holds 4.5:1', () => {
      expect(contrast(hex('--code-ink'), hex('--code-bg'))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(['--warning', '--danger', '--success', '--accent-text'])(
      'a callout title in %s holds 4.5:1 on its 6%% wash of the surface',
      (tint) => {
        const ground = mix(hex(tint), 0.06, hex('--surface'));
        expect(contrast(hex(tint), ground)).toBeGreaterThanOrEqual(4.5);
      },
    );
  },
);

/* ---- the rules the state contrast above relies on ---- */

/** Every rule as its selectors and declarations, so a state's ink can be read from the sheet. */
const sheetRules = [
  ...readStylesheet()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((rule) => ({
  selectors: (rule[1] ?? '').split(',').map((part) => part.trim()),
  declarations: new Map(
    [...(rule[2] ?? '').matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((d) => [
      d[1] ?? '',
      (d[2] ?? '').trim(),
    ]),
  ),
}));

const colourOf = (selector: string) =>
  sheetRules
    .filter((rule) => rule.selectors.includes(selector))
    .at(-1)
    ?.declarations.get('color');

describe('the rules that step a state’s ink up to --ink-2', () => {
  // The token pairs above pass only because these rules exist: --ink-3 on
  // --selected is 4.32:1 in light, and --ink-3 under the 16% wash is under 4.5
  // in both themes. Dropping either rule would leave the pair tests green.
  it('the selected suggestion row’s path', () => {
    expect(colourOf('.suggest-option--on .suggest-option__path')).toBe('var(--ink-2)');
  });

  it('a header cell inside a cell selection', () => {
    expect(colourOf('.editor th.selectedCell')).toBe('var(--ink-2)');
  });
});

/* ---- the cascade between a state and a hover ---- */

const css = readStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rules whose selectors are one compound of classes and `:hover`. */
const compoundRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule, order) =>
  (rule[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((selector) => /^(\.[\w-]+|:hover)+$/.test(selector))
    .map((selector) => ({
      parts: selector.match(/\.[\w-]+|:hover/g) ?? [],
      order,
      declarations: new Map(
        [...(rule[2] ?? '').matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((d) => [
          d[1] ?? '',
          (d[2] ?? '').trim(),
        ]),
      ),
    })),
);

/** The value the cascade gives `property` on an element with these classes, hovered or not. */
function cascaded(
  classes: readonly string[],
  hovered: boolean,
  property: string,
): string | undefined {
  const matching = compoundRules
    .filter((rule) => rule.declarations.has(property))
    .filter((rule) =>
      rule.parts.every((part) => (part === ':hover' ? hovered : classes.includes(part))),
    )
    .sort((a, b) => a.parts.length - b.parts.length || a.order - b.order);
  return matching.at(-1)?.declarations.get(property);
}

describe('a broken or missing card under the pointer', () => {
  it('keeps a broken block embed’s danger border at rest (the resolver reads the sheet)', () => {
    expect(cascaded(['.block-embed', '.block-embed--broken'], false, 'border-color')).toBe(
      'var(--btn-destructive-line)',
    );
  });

  it('keeps a broken block embed’s danger border while it is hovered', () => {
    // `.block-embed:hover` (0,2,0) outranks `.block-embed--broken` (0,1,0), so
    // the hover's --line-strong replaces the only sign the embed is broken.
    expect(cascaded(['.block-embed', '.block-embed--broken'], true, 'border-color')).toBe(
      'var(--btn-destructive-line)',
    );
  });
});
