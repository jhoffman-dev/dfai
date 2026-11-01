import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readStylesheet } from './styles.test-support.ts';

/**
 * Settings and the Welcome screen by the brief's rules (UI v2 slice 13f,
 * #315): Settings is hairline sections under a 15/600 title with 28px
 * controls and a list of sections at 28px rows; the Welcome screen is a
 * 24/600 title, one paragraph and secondary buttons, with no tile and no
 * card. Every ink either surface draws text in clears AA on it, in both
 * themes. Read from the sheet itself, since jsdom draws nothing.
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

/** What the sheet says of one selector at rest: its own rules' declarations, later ones winning. */
function styleOf(selector: string): Map<string, string> {
  const own = rules.filter((rule) => rule.selectors.includes(selector));
  if (own.length === 0) throw new Error(`no rule for ${selector}`);
  return new Map(own.flatMap((rule) => [...rule.declarations]));
}

const hasRule = (selector: string) => rules.some((rule) => rule.selectors.includes(selector));

/** The light palette and the dark one, each as its declarations. */
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
const palettes = {
  light: paletteOf(":root,\n[data-theme='light']"),
  dark: paletteOf("[data-theme='dark'] {"),
};

type Rgb = readonly [number, number, number];

function resolve(theme: Map<string, string>, name: string): string {
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
  const value = resolve(theme, name);
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

/** The `color` token a selector's own rules give it, if any. */
function inkOf(selector: string): string | null {
  const color = styleOf(selector).get('color') ?? null;
  const token = color === null ? null : /^var\((--[\w-]+)\)$/.exec(color);
  return token === null ? null : (token[1] ?? null);
}

/** The text Settings draws, and the ground each run sits on. */
const SETTINGS_TEXT: readonly { readonly selector: string; readonly ground: string }[] = [
  { selector: '.settings__nav-row', ground: '--bg' },
  { selector: '.settings__nav-row .settings__nav-icon', ground: '--bg' },
  { selector: '.settings__lede', ground: '--surface' },
  { selector: '.settings__file', ground: '--surface' },
  { selector: '.settings__status', ground: '--surface' },
  { selector: '.settings__notice', ground: '--surface' },
  { selector: '.settings__problem', ground: '--surface' },
  { selector: '.settings__code', ground: '--code-bg' },
  { selector: '.secrets__usage', ground: '--surface' },
  { selector: '.quick-add-settings__missing', ground: '--surface' },
  { selector: '.empty__body', ground: '--surface' },
];

describe('Settings (slice 13f)', () => {
  it('draws a section as a hairline group: a line above, no fill, no shadow, no radius', () => {
    const section = styleOf('.settings__section');
    expect(section.get('border-top')).toBe('1px solid var(--line)');
    expect(section.has('background')).toBe(false);
    expect(section.has('box-shadow')).toBe(false);
    expect(section.has('border-radius')).toBe(false);
    expect(hasRule('.settings__card')).toBe(false);
  });

  it('titles a section at 15/600, and the dialog the same', () => {
    for (const selector of ['.settings__heading', '.settings__title']) {
      expect(styleOf(selector).get('font-size'), selector).toBe('var(--text-section)');
      expect(styleOf(selector).get('font-weight'), selector).toBe('600');
    }
  });

  it('has no icon tile in its head or its headings', () => {
    expect(hasRule('.settings__tile')).toBe(false);
    expect(hasRule('.settings__heading-icon')).toBe(false);
  });

  it('lists the sections at 28px rows, on the sidebar’s grey', () => {
    expect(styleOf('.settings__nav-row').get('height')).toBe('var(--sidebar-row)');
    expect(aliases.get('--sidebar-row') ?? paletteOf(':root {').get('--sidebar-row')).toBe('28px');
    expect(styleOf('.settings__nav').get('background')).toBe('var(--bg)');
    expect(styleOf('.settings__nav').get('border-right')).toBe('1px solid var(--line)');
  });

  it('draws a row bare, with its control at 28px', () => {
    const row = styleOf('.settings__row');
    expect(row.has('background')).toBe(false);
    expect(row.has('border-radius')).toBe(false);
    expect(styleOf('.settings__field').get('height')).toBe('28px');
    expect(styleOf('.quick-add-settings__add').get('height')).toBe('28px');
    expect(styleOf('.btn').get('height')).toBe('28px');
  });

  it('keeps every weight in Settings and on Welcome to 400, 500 or 600', () => {
    const heavy = rules.filter(
      (rule) =>
        rule.selectors.some((selector) =>
          /^\.(settings|secrets|quick-add-settings|empty)/.test(selector),
        ) && /^[789]00$/.test(rule.declarations.get('font-weight') ?? ''),
    );
    expect(heavy.map((rule) => rule.selectors.join(', '))).toEqual([]);
  });

  it('draws its rows and the sections’ hairlines in the line tokens only', () => {
    expect(styleOf('.secrets__item').get('border-top')).toBe('1px solid var(--line-soft)');
    expect(styleOf('.secrets__item').has('background')).toBe(false);
    expect(styleOf('.quick-add-settings__row').get('border-top')).toBe(
      '1px solid var(--line-soft)',
    );
    expect(styleOf('.quick-add-settings__row').has('background')).toBe(false);
  });
});

describe('a field, as Settings asks in them', () => {
  // Held here since the quick-add popover, which held it before, was retired (UI v2, Q5).
  it('is the 28px field primitive, ringed when focused', () => {
    expect(styleOf('.field').get('height')).toBe('28px');
    expect(styleOf('.field:focus').get('box-shadow')).toBe('var(--ring)');
  });
});

describe('Welcome (slice 13f)', () => {
  it('is a 24/600 title, one paragraph in ink-2, and no tile or card', () => {
    expect(styleOf('.empty__title').get('font-size')).toBe('var(--text-note-title)');
    expect(styleOf('.empty__title').get('font-weight')).toBe('600');
    expect(styleOf('.empty__body').get('color')).toBe('var(--ink-2)');
    expect(hasRule('.empty__tile')).toBe(false);
    expect(hasRule('.empty__card')).toBe(false);
    expect(styleOf('.empty__intro').has('background')).toBe(false);
    expect(styleOf('.empty__intro').has('box-shadow')).toBe(false);
  });
});

describe.each(Object.entries(palettes))(
  'text in Settings and on Welcome, %s theme',
  (_name, theme) => {
    it.each(SETTINGS_TEXT)('$selector clears AA (4.5:1) on $ground', ({ selector, ground }) => {
      const ink = inkOf(selector);
      if (ink === null) throw new Error(`${selector} sets no colour token`);
      expect(contrast(paint(theme, ink), paint(theme, ground))).toBeGreaterThanOrEqual(4.5);
    });

    it('the Welcome title and a row’s label, in ink, clear AA on the surface', () => {
      expect(contrast(paint(theme, '--ink'), paint(theme, '--surface'))).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  },
);

/** The Settings sections, as the UI package draws them. */
const SECTION_SOURCES = [
  'settings-dialog.tsx',
  'appearance-settings.tsx',
  'profile-settings.tsx',
  'secrets-settings.tsx',
  'image-settings.tsx',
  'granola-settings.tsx',
  'google-calendar-settings.tsx',
  'global-capture-settings.tsx',
  'quick-add-settings.tsx',
  'index-status.tsx',
  'sync/sync-settings.tsx',
  'chat/claude-settings.tsx',
].map((name) => fileURLToPath(new URL(`../../../packages/ui/src/${name}`, import.meta.url)));

it('no Settings section draws a 22px button: every button is the shared 28px kind', () => {
  for (const file of SECTION_SOURCES) {
    expect(readFileSync(file, 'utf8'), file).not.toContain('btn--sm');
  }
});
