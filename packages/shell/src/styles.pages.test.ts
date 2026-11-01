import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The fixed pages' lists (UI v2 slice 13b, #311): Activity, Templates, Terms,
 * the Archive and Automations list things that are not notes on the table
 * view's 34px hairline rows (page.css .page-list), the title at 13/500 and
 * the metadata in ink-3 on the same line; Activity's filters are ghost
 * controls; an automation is a row rather than a card, with the run log as
 * rows under its editor. These hold the rules the pages share — no shadow,
 * a hairline between rows, the row's height — and that every ink a row, a
 * notice, a pressed filter or the log's status words put on their ground
 * clears AA (WCAG 1.4.3, 4.5:1) in both themes.
 */

const sheet = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./styles/${file}`, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
const tokens = sheet('tokens.css');
const page = sheet('page.css');
const activity = sheet('activity.css');
const automations = sheet('automations.css');
const archive = sheet('archive.css');
const templates = sheet('templates.css');
const terms = sheet('terms.css');

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

/** The first token a declaration reads. */
const tokenIn = (declaration: string | undefined) =>
  /var\((--[\w-]+)\)/.exec(declaration ?? '')?.[1] ?? '';

const row = blockOf(page, '.page-list__row {');
const rowHover = blockOf(page, '.page-list__row:hover {');
const title = blockOf(page, '.page-list__title {');
const meta = blockOf(page, '.page-list__meta {');
const sectionTitle = blockOf(page, '.page-section__title {');
const form = blockOf(page, '.page-form {');
const search = blockOf(page, '.page-search {');
const kindPressed = blockOf(activity, ".activity__kind[aria-pressed='true']");
const levelWarning = blockOf(activity, '.activity-line__level--warning {');
const levelError = blockOf(activity, '.activity-line__level--error {');
const card = blockOf(automations, '.automation-card {');
const cardOpen = blockOf(automations, '.automation-card--open');
const cardOpenMeta = blockOf(automations, '.automation-card--open .automation-card__what,');
const cardWhat = blockOf(automations, '.automation-card__what {');
const cardNotice = blockOf(automations, '.automation-card__notice {');
const notice = blockOf(automations, '.automations__notice {');
const editor = blockOf(automations, '.automation-editor {');
const logEntry = blockOf(automations, '.automation-log__entry {');
const logLine = blockOf(automations, '.automation-log__line {');
const logLeft = blockOf(automations, '.automation-log__line--left {');
const archiveFrom = blockOf(archive, '.archive__grid .archive__from,');
const templateUses = blockOf(templates, '.templates__grid .templates__uses {');
const termKind = blockOf(terms, '.terms__grid .terms__kind {');
const inConflict = blockOf(terms, '.terms__in-conflict {');

describe('the fixed pages’ rows', () => {
  it('are the table view’s: 34px, divided by line-soft, hover under the pointer, no shadow', () => {
    expect(row.get('height')).toBe('34px');
    expect(tokenIn(row.get('border-bottom'))).toBe('--line-soft');
    expect(row.has('box-shadow')).toBe(false);
    expect(tokenIn(rowHover.get('background'))).toBe('--hover');
  });

  it('set the title at 13/500 and the metadata at 12 in ink-3, each on one line', () => {
    expect(tokenIn(title.get('font-size'))).toBe('--text-emphasis');
    expect(title.get('font-weight')).toBe('500');
    expect(title.get('white-space')).toBe('nowrap');
    expect(tokenIn(meta.get('font-size'))).toBe('--text-meta');
    expect(tokenIn(meta.get('color'))).toBe('--ink-3');
    expect(meta.get('white-space')).toBe('nowrap');
  });

  it('head a section at 15/600 over a hairline', () => {
    expect(tokenIn(sectionTitle.get('font-size'))).toBe('--text-section');
    expect(sectionTitle.get('font-weight')).toBe('600');
    expect(tokenIn(sectionTitle.get('border-bottom'))).toBe('--line');
  });

  it('put a new-thing form on the well between hairlines, with no shadow', () => {
    expect(tokenIn(form.get('background'))).toBe('--well');
    expect(tokenIn(form.get('border-top'))).toBe('--line');
    expect(form.has('box-shadow')).toBe(false);
  });

  it('draw the search as a 28px field with a hairline, not a pill with a shadow', () => {
    expect(search.get('height')).toBe('28px');
    expect(tokenIn(search.get('border'))).toBe('--line-strong');
    expect(tokenIn(search.get('border-radius'))).toBe('--radius-control');
    expect(search.has('box-shadow')).toBe(false);
  });
});

describe('each page’s own rules', () => {
  it('Activity: a chosen kind wears the pressed-toggle fill in full ink, with no pill', () => {
    expect(tokenIn(kindPressed.get('background'))).toBe('--selected');
    expect(tokenIn(kindPressed.get('color'))).toBe('--ink');
    expect(activity).not.toContain('--radius-pill');
  });

  it('Automations: a rule is a row, not a card, and the open one wears the active fill', () => {
    expect(card.has('box-shadow')).toBe(false);
    expect(card.has('background')).toBe(false);
    expect(tokenIn(cardOpen.get('background'))).toBe('--selected');
    expect(tokenIn(cardWhat.get('color'))).toBe('--ink-3');
    expect(cardWhat.get('white-space')).toBe('nowrap');
  });

  it('Automations: the editor and its log are between hairlines, the log’s entries rows', () => {
    expect(editor.has('box-shadow')).toBe(false);
    expect(tokenIn(editor.get('border-bottom'))).toBe('--line');
    expect(tokenIn(logEntry.get('border-bottom'))).toBe('--line-soft');
    expect(logEntry.has('border-left')).toBe(false);
    expect(tokenIn(notice.get('background'))).toBe('--well');
  });

  it('the Archive leaves its header and rows to the table (slice 4), its metadata in ink-3', () => {
    expect(archive).not.toContain('font-weight: 700');
    expect(archive).not.toContain('--shadow-soft');
    expect(tokenIn(archiveFrom.get('color'))).toBe('--ink-3');
    expect(tokenIn(archiveFrom.get('font-size'))).toBe('--text-meta');
  });

  it('Templates and Terms set a row’s metadata in ink-3 on one line', () => {
    expect(tokenIn(templateUses.get('color'))).toBe('--ink-3');
    expect(templateUses.get('white-space')).toBe('nowrap');
    expect(tokenIn(termKind.get('color'))).toBe('--ink-3');
    expect(templates).not.toContain('--shadow-soft');
    expect(terms).not.toContain('--shadow-soft');
  });
});

describe.each(Object.entries(themes))('page list contrast, %s theme', (_name, theme) => {
  const on = (mark: string, ground: string) =>
    contrast(resolve(theme, mark), resolve(theme, ground));
  /** What a row can be painted with: the surface, the pointer’s fill, the open row’s fill. */
  const grounds = ['--surface', '--hover', '--selected'] as const;

  it.each(grounds)('a title, in ink, clears AA on %s', (ground) => {
    expect(on(tokenIn(title.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['--surface', '--hover'])('the metadata, in ink-3, clears AA on %s', (ground) => {
    expect(on(tokenIn(meta.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('the open rule’s metadata, lifted to ink-2, clears AA on the active fill — ink-3 would not', () => {
    const fill = tokenIn(cardOpen.get('background'));
    expect(tokenIn(cardOpenMeta.get('color'))).toBe('--ink-2');
    expect(on(tokenIn(cardOpenMeta.get('color')), fill)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(grounds)('a ghost button’s ink clears AA on %s', (ground) => {
    expect(on('--btn-ghost-ink', ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('a pressed kind filter’s ink clears AA on its fill', () => {
    expect(
      on(tokenIn(kindPressed.get('color')), tokenIn(kindPressed.get('background'))),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(grounds)('the level words Warning and Error keep their inks at AA on %s', (ground) => {
    expect(on(tokenIn(levelWarning.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(levelError.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(grounds)('a rule’s notice, in the warning ink, clears AA on %s', (ground) => {
    expect(on(tokenIn(cardNotice.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('the run log’s lines, and a note it left in the warning ink, clear AA on the surface and under the pointer', () => {
    for (const ground of ['--surface', '--hover']) {
      expect(on(tokenIn(logLine.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
      expect(on(tokenIn(logLeft.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('a term’s conflict note, in the warning ink, clears AA on the surface', () => {
    expect(on(tokenIn(inConflict.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
  });

  it('the notice’s words clear AA on the well, and a form’s labels on the well', () => {
    expect(on(tokenIn(notice.get('color')), '--well')).toBeGreaterThanOrEqual(4.5);
    expect(on('--ink-3', '--well')).toBeGreaterThanOrEqual(4.5);
  });

  it('the section title clears AA on the surface', () => {
    expect(on(tokenIn(sectionTitle.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
  });
});
