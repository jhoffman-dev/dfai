import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The graph, the Tags page and the Query page (UI v2 slice 13g, #316): the
 * graph's scope controls are a hairline section of ghost toggles and its list
 * the fixed pages' 34px rows, with every node colour a token; the Tags page is
 * 34px hairline rows with the count in ink-3 (none at 0) and a 28px rename
 * field; the Query page's editor, text and builder are radius-6 fields in
 * 12px mono over hairline groups. No card, no shadow, no pill on any of them,
 * and every ink a label, a count, a problem or a canvas label puts on its
 * ground clears AA (WCAG 1.4.3, 4.5:1) in both themes.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
const tokens = read('./styles/tokens.css');
const graph = read('./styles/graph.css');
const queries = read('./styles/queries.css');
const editor = read('./styles/editor.css');
const canvas = read('../../../packages/ui/src/graph/graph-canvas.tsx');

/** The `.tags*` and `.tag-rename*` rules, which share the editor's sheet. */
const tags = editor.slice(editor.indexOf('.tags {'), editor.indexOf('.atlas-suggestion {'));
/** The Query page and the DFAI query rules, after the saved-view popovers. */
const query = queries.slice(queries.indexOf('.query {'));

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

const RAW_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;

const controls = blockOf(graph, '.graph__controls {');
const chip = blockOf(graph, '.graph__chip {');
const chipOff = blockOf(graph, ".graph__chip[aria-pressed='false'] {");
const stage = blockOf(graph, '.graph__stage {');
const nodeLabel = blockOf(graph, '.graph__label {');
const edgeLabel = blockOf(graph, '.graph__edge-label {');
const graphNotice = blockOf(graph, '.graph__notice {');
const listItem = blockOf(graph, '.graph__list-item {');
const listNote = blockOf(graph, '.graph__list-note {');
const listTitle = blockOf(graph, '.graph__list-title {');
const listType = blockOf(graph, '.graph__list-type {');
const listLink = blockOf(graph, '\n\n.graph__list-link {');
const listWay = blockOf(graph, '.graph__list-way {');

const tagPanes = blockOf(tags, '.tags__index,\n.tags__detail {');
const tagRow = blockOf(tags, '.tags__row,\n.tags__note {');
const tagRowOn = blockOf(tags, '.tags__item--on > .tags__row,');
const tagCount = blockOf(tags, '.tags__count {');
const tagCountOn = blockOf(tags, '.tags__item--on > .tags__row .tags__count {');
const tagTitle = blockOf(tags, '.tags__title {');
const tagUses = blockOf(tags, '.tags__uses {');
const tagNotice = blockOf(tags, '.tags__notice {');
const tagHint = blockOf(tags, '.tags__hint {');
const renameForm = blockOf(tags, '.tag-rename {');
const renameLabel = blockOf(tags, '.tag-rename__label {');
const renameField = blockOf(tags, '.tag-rename__row {');
const renameProblem = blockOf(tags, '.tag-rename__problem,');

const sqlEditor = blockOf(query, '.query__editor {');
const sqlText = blockOf(query, '.query__sql {');
const sqlGutter = blockOf(query, '.query__gutter {');
const sqlError = blockOf(query, '.query__error {');
const schema = blockOf(query, '.query__schema {');
const foldText = blockOf(query, '.aquery__fold-text {');
const builder = blockOf(query, '.qb {');
const builderRow = blockOf(query, '.qb__row {');
const builderLabel = blockOf(query, '.qb__label {');
const builderChip = blockOf(query, '.qb__chip {');
const condition = blockOf(query, '.qb__condition,\n.qb__pair {');
const notPressed = blockOf(query, ".qb__not[aria-pressed='true'] {");
const add = blockOf(query, '.qb__add {');
const textArea = blockOf(query, '.qtext__area {');
const textProblem = blockOf(query, '.qtext__problem {');
const textMessage = blockOf(query, '.qtext__message {');
const textLine = blockOf(query, '.qtext__line {');
const group = blockOf(query, '.qresult__group {');
const heading = blockOf(query, '.qresult__heading {');
const headingDeep = blockOf(query, '.qresult__heading--level-2 {');
const groupCount = blockOf(query, '.qresult__count {');
const card = blockOf(query, '.qresult__card {');
const cardMeta = blockOf(query, '.qresult__card-meta {');

describe('the graph', () => {
  it('puts its scope controls in a hairline section of ghost toggles, with no pill', () => {
    expect(tokenIn(controls.get('border-bottom'))).toBe('--line');
    expect(tokenIn(chip.get('background'))).toBe('--btn-ghost-bg');
    expect(tokenIn(chip.get('border-radius'))).toBe('--radius-button');
    expect(chip.get('height')).toBe('28px');
    expect(chipOff.has('opacity')).toBe(false);
    expect(graph).not.toContain('--radius-pill');
  });

  it('draws the stage on the surface with no shadow, and the notice on the well', () => {
    expect(stage.has('box-shadow')).toBe(false);
    expect(tokenIn(stage.get('background'))).toBe('--surface');
    expect(tokenIn(graphNotice.get('background'))).toBe('--well');
    expect(graph).not.toContain('--shadow-card');
  });

  it('colours every node, swatch, edge and label from a token: no raw colour in the sheet or the canvas', () => {
    expect(graph).not.toMatch(RAW_COLOUR);
    expect(canvas).not.toMatch(RAW_COLOUR);
    for (const tone of ['backlog', 'inbox', 'next', 'doing', 'waiting', 'review', 'done']) {
      expect(tokenIn(blockOf(graph, `.graph__swatch[data-tone='${tone}']`).get('background'))).toBe(
        `--status-${tone}-dot`,
      );
    }
    expect(canvas).toContain('var(--graph-untyped)');
    expect(canvas).toContain('var(--status-${tone}-dot)');
  });

  it('lists the notes as 34px hairline rows at 13/500, their links 28px rows under them', () => {
    expect(listNote.get('height')).toBe('34px');
    expect(tokenIn(listNote.get('font-size'))).toBe('--text-emphasis');
    expect(listNote.get('font-weight')).toBe('500');
    expect(tokenIn(listItem.get('border-bottom'))).toBe('--line-soft');
    expect(listLink.get('height')).toBe('28px');
    expect(tokenIn(listType.get('color'))).toBe('--ink-3');
    expect(tokenIn(listType.get('font-size'))).toBe('--text-meta');
  });

  it('ellipsises a title in a note row and a link row alike, since neither row wraps', () => {
    expect(listNote.has('white-space')).toBe(false);
    expect(listLink.get('white-space')).toBe('nowrap');
    expect(listTitle.get('min-width')).toBe('0');
    expect(listTitle.get('overflow')).toBe('hidden');
    expect(listTitle.get('text-overflow')).toBe('ellipsis');
    expect(listTitle.get('white-space')).toBe('nowrap');
  });
});

describe('the Tags page', () => {
  it('is two hairline-divided lists of 34px rows at 13/500, in no card', () => {
    expect(tagPanes.has('box-shadow')).toBe(false);
    expect(tagPanes.has('background')).toBe(false);
    expect(tagRow.get('height')).toBe('34px');
    expect(tokenIn(tagRow.get('border-bottom'))).toBe('--line-soft');
    expect(tokenIn(tagRow.get('font-size'))).toBe('--text-emphasis');
    expect(tagRow.get('font-weight')).toBe('500');
    expect(tags).not.toContain('--shadow-card');
    expect(tags).not.toContain('--radius-pill');
  });

  it('marks the chosen tag with the active fill in full ink, its count lifted to ink-2', () => {
    expect(tokenIn(tagRowOn.get('background'))).toBe('--selected');
    expect(tokenIn(tagRowOn.get('color'))).toBe('--ink');
    expect(tokenIn(tagCount.get('color'))).toBe('--ink-3');
    expect(tagCount.has('background')).toBe(false);
    expect(tokenIn(tagCountOn.get('color'))).toBe('--ink-2');
  });

  it('heads the chosen tag at 15/600 and renames it in a 28px field on the well', () => {
    expect(tokenIn(tagTitle.get('font-size'))).toBe('--text-section');
    expect(tagTitle.get('font-weight')).toBe('600');
    expect(tokenIn(renameForm.get('background'))).toBe('--well');
    expect(renameForm.has('box-shadow')).toBe(false);
    expect(renameField.get('height')).toBe('28px');
    expect(tokenIn(renameField.get('border'))).toBe('--line-strong');
    expect(tokenIn(renameField.get('border-radius'))).toBe('--radius-control');
  });

  it('measures its one-column layout against the page, never the window or .page--wide', () => {
    expect(tags).toContain('container: tags / inline-size');
    expect(tags).toContain('@container tags (max-width: 720px)');
    expect(tags).not.toContain('@media');
    expect(tags).not.toContain('.page--wide');
  });
});

describe('the Query page', () => {
  it('writes SQL and a DFAI query in radius-6 fields in 12px mono', () => {
    for (const field of [sqlEditor, textArea]) {
      expect(tokenIn(field.get('border'))).toBe('--line-strong');
      expect(tokenIn(field.get('border-radius'))).toBe('--radius-control');
      expect(tokenIn(field.get('font'))).toBe('--text-mono');
      expect(field.has('box-shadow')).toBe(false);
    }
    expect(tokenIn(foldText.get('font'))).toBe('--text-mono');
    expect(tokenIn(foldText.get('border-radius'))).toBe('--radius-control');
  });

  it('lays the builder out as hairline groups — no card, no pill — with ghost Add buttons', () => {
    expect(builder.has('background')).toBe(false);
    expect(builder.has('box-shadow')).toBe(false);
    expect(tokenIn(builderRow.get('border-bottom'))).toBe('--line');
    expect(tokenIn(condition.get('border'))).toBe('--line');
    expect(tokenIn(condition.get('border-radius'))).toBe('--radius-control');
    expect(tokenIn(builderChip.get('border-radius'))).toBe('--radius-chip');
    expect(tokenIn(add.get('color'))).toBe('--btn-ghost-ink');
    expect(query).not.toContain('--radius-pill');
    expect(query).not.toContain('--shadow-soft');
    expect(query).not.toContain('--shadow-card');
  });

  it('puts a problem and the tables in hairline sections, and the groups over hairlines', () => {
    expect(tokenIn(sqlError.get('background'))).toBe('--well');
    expect(sqlError.has('box-shadow')).toBe(false);
    expect(tokenIn(textProblem.get('background'))).toBe('--well');
    expect(tokenIn(schema.get('border-left'))).toBe('--line');
    expect(schema.has('box-shadow')).toBe(false);
    expect(tokenIn(group.get('border-top'))).toBe('--line');
    expect(tokenIn(card.get('border'))).toBe('--line');
    expect(card.has('box-shadow')).toBe(false);
  });

  it('measures its one-column layout against the page, never the window or .page--wide', () => {
    expect(query).toContain('container: query / inline-size');
    expect(query).toContain('@container query (max-width: 860px)');
    expect(query).not.toContain('@media');
    expect(query).not.toContain('.page--wide');
  });
});

describe.each(Object.entries(themes))('contrast, %s theme', (_name, theme) => {
  const on = (mark: string, ground: string) =>
    contrast(resolve(theme, mark), resolve(theme, ground));
  const rowGrounds = ['--surface', '--hover'] as const;

  it('a graph node’s label, and an edge’s, clear AA on the canvas ground', () => {
    expect(
      on(tokenIn(nodeLabel.get('fill')), tokenIn(stage.get('background'))),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      on(tokenIn(edgeLabel.get('fill')), tokenIn(stage.get('background'))),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(rowGrounds)('a type toggle, shown or left out, clears AA on %s', (ground) => {
    expect(on(tokenIn(chip.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(chipOff.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(rowGrounds)('the graph list’s type and link-way, in ink-3, clear AA on %s', (ground) => {
    expect(on(tokenIn(listType.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(listWay.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('the capped-graph notice clears AA on the well', () => {
    expect(on(tokenIn(graphNotice.get('color')), '--well')).toBeGreaterThanOrEqual(4.5);
  });

  it.each([...rowGrounds, '--selected'])('a tag row’s name clears AA on %s', (ground) => {
    expect(on(tokenIn(tagRow.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('a tag’s count clears AA on the surface and under the pointer, and lifted on the active fill', () => {
    for (const ground of rowGrounds) {
      expect(on(tokenIn(tagCount.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    }
    expect(on(tokenIn(tagCountOn.get('color')), '--selected')).toBeGreaterThanOrEqual(4.5);
  });

  it('the tag head, its uses, the hint and the notice clear AA on their grounds', () => {
    expect(on(tokenIn(tagTitle.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(tagUses.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(tagHint.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(tagNotice.get('color')), '--well')).toBeGreaterThanOrEqual(4.5);
  });

  it('the rename form’s label, and a refused name in the danger ink, clear AA on the well', () => {
    expect(on(tokenIn(renameLabel.get('color')), '--well')).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(renameProblem.get('color')), '--well')).toBeGreaterThanOrEqual(4.5);
  });

  it('SQL and its line numbers clear AA in the field; a refusal clears AA on the well', () => {
    expect(on(tokenIn(sqlText.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(sqlGutter.get('color')), '--surface')).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(sqlError.get('color')), '--well')).toBeGreaterThanOrEqual(4.5);
  });

  it('the folded query’s text clears AA on the code ground', () => {
    expect(on(tokenIn(foldText.get('color')), '--code-bg')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(rowGrounds)('a builder label, a type chip and an Add button clear AA on %s', (ground) => {
    expect(on(tokenIn(builderLabel.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(add.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('a type chip’s words clear AA on the chip, and a pressed "not" on the pressed-toggle fill', () => {
    expect(
      on(tokenIn(builderChip.get('color')), tokenIn(builderChip.get('background'))),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      on(tokenIn(notPressed.get('color')), tokenIn(notPressed.get('background'))),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('what is wrong with the text, and the line it points at, clear AA on the well', () => {
    expect(on(tokenIn(textMessage.get('color')), '--well')).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(textLine.get('color')), '--well')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(rowGrounds)(
    'a group’s heading, a sub-group’s, and their counts clear AA on %s',
    (ground) => {
      expect(on(tokenIn(heading.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
      expect(on(tokenIn(headingDeep.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
      expect(on(tokenIn(groupCount.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(rowGrounds)('a card’s title and metadata clear AA on %s', (ground) => {
    expect(on(tokenIn(card.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
    expect(on(tokenIn(cardMeta.get('color')), ground)).toBeGreaterThanOrEqual(4.5);
  });
});
