import type { EditorDocument, EditorNode } from '@dfai/domain';
import {
  CAN_CARRY_AN_ID,
  EMBED_FRAGMENTS,
  HREFS,
  SRCS,
  TARGETS,
} from './writer-fuzz.test-support.ts';
import {
  ADDRESSES,
  CONTAINERS,
  EVERY_PIECE,
  HOLDERS,
  INLINE_KINDS,
  LINK_MARKINGS,
  MARKINGS,
  markSetKey,
  NESTED,
  OPENERS,
  TOP_KINDS,
} from './writer-listed.test-support.ts';

/**
 * The shapes the writer's property tests turn on (#888): what a document
 * holds, told by walking it, and every one there is, named from the seeded
 * generator's lists. A test shows its documents hold them all, so a listed
 * document that is taken out, or a list that grows, is seen.
 */

/** The shapes the writer's property turns on that a document holds. */
export function shapesOf(doc: EditorDocument): Set<string> {
  const shapes = new Set<string>();
  const visit = (node: EditorNode, parent: string, top: boolean) => {
    for (const shape of nodeShapes(node, parent, top)) shapes.add(shape);
    const container = HOLDERS.has(parent) || parent.startsWith('table') ? parent : node.type;
    if (node.type === 'paragraph' || node.type === 'heading')
      for (const shape of lineShapes(node.content ?? [], container)) shapes.add(shape);
    for (const child of node.content ?? []) visit(child, node.type, false);
  };
  for (const node of doc.content) visit(node, 'doc', true);
  doc.content
    .slice(1)
    .forEach((node, at) => shapes.add(`${node.type} after ${doc.content[at]!.type}`));
  return shapes;
}

function nodeShapes(node: EditorNode, parent: string, top: boolean): string[] {
  const attrs = node.attrs ?? {};
  const shapes = [`${node.type} in ${parent}`];
  if (typeof attrs['anchor'] === 'string') shapes.push(`id on ${node.type}${top ? ' at top' : ''}`);
  if (node.type === 'heading') shapes.push(`heading ${String(attrs['level'])}`);
  if (node.type === 'orderedList') shapes.push(`ordered from ${String(attrs['start'])}`);
  if (node.type === 'taskItem') shapes.push(`task checked ${String(attrs['checked'])}`);
  if (node.type === 'callout') shapes.push(`callout titled ${attrs['title'] !== null}`);
  if (node.type === 'image')
    shapes.push(
      `image of ${String(attrs['src'])}`,
      `image alt ${attrs['alt'] === null ? 'none' : 'some'}`,
    );
  if (node.type === 'image' && typeof attrs['alt'] === 'string')
    shapes.push(
      ...EVERY_PIECE.filter((p) => (attrs['alt'] as string).includes(p)).map(
        (p) => `${JSON.stringify(p)} in alt`,
      ),
    );
  if (['wikiLink', 'bookmark', 'blockEmbed'].includes(node.type)) shapes.push(...linkShapes(node));
  return shapes;
}

function linkShapes(node: EditorNode): string[] {
  const attrs = node.attrs ?? {};
  const shapes = [
    `${node.type} to ${String(attrs['target'])}`,
    `${node.type} heading ${String(attrs['heading'])}`,
    `${node.type} alias ${attrs['alias'] !== null}`,
  ];
  if (node.type === 'wikiLink') {
    shapes.push(`wikiLink embed ${attrs['embed'] === true}`);
    const marks = node.marks ?? [];
    shapes.push(
      ...(marks.length === 0 ? ['none'] : marks.map((mark) => mark.type)).map(
        (m) => `wikiLink ${m}`,
      ),
    );
  }
  return shapes;
}

const markingsOf = (node: EditorNode): string[] =>
  (node.marks ?? []).length === 0 ? ['none'] : (node.marks ?? []).map((mark) => mark.type);

/** What each address in `value` has straight before and after it. */
function addressShapes(value: string, marking: string, start: boolean): string[] {
  return ADDRESSES.flatMap((address) => {
    const name = JSON.stringify(address);
    return [...value].flatMap((_, at) => {
      if (!value.startsWith(address, at)) return [];
      const after = value.slice(at + address.length);
      return [
        ...ADDRESSES.filter((next) => after.startsWith(next)).map(
          (next) => `${name} before ${JSON.stringify(next)} in ${marking}`,
        ),
        ...(/^\w/.test(after) ? [`${name} before a word in ${marking}`] : []),
        ...(/\w$/.test(value.slice(0, at)) ? [`${name} after a word in ${marking}`] : []),
        ...(OPENERS.some((opener) => after.includes(opener))
          ? [`${name} before markup in ${marking}`]
          : []),
        ...ADDRESSES.filter((next) => at === 0 && start && after.startsWith(next)).map(
          (next) => `${name} starts a line before ${JSON.stringify(next)} in ${marking}`,
        ),
      ];
    });
  });
}

const inlineKindOf = (node: EditorNode): string =>
  node.type === 'text' ? markSetKey((node.marks ?? []).map((mark) => mark.type)) : node.type;

/** What a line of a text block starts and ends with, and the pieces under each mark in it. */
function lineShapes(content: readonly EditorNode[], container: string): string[] {
  const shapes: string[] = [];
  const first = content[0];
  const last = content.at(-1);
  for (const p of EVERY_PIECE) {
    const name = JSON.stringify(p);
    if (first?.type === 'text' && first.text?.startsWith(p))
      shapes.push(`${name} starts ${container}`);
    if (last?.type === 'text' && last.text?.endsWith(p)) shapes.push(`${name} ends ${container}`);
  }
  content
    .slice(1)
    .forEach((node, at) =>
      shapes.push(`${inlineKindOf(node)} after ${inlineKindOf(content[at]!)}`),
    );
  for (const node of content) {
    if (node.type === 'hardBreak') shapes.push(`line break in ${container}`);
    if (node.type !== 'text') continue;
    for (const mark of node.marks ?? [])
      if (mark.type === 'link') shapes.push(`link to ${String(mark.attrs?.['href'])}`);
    for (const marking of markingsOf(node))
      shapes.push(...addressShapes(node.text ?? '', marking, node === first));
    for (const p of EVERY_PIECE)
      if (node.text?.includes(p))
        for (const marking of markingsOf(node)) shapes.push(`${JSON.stringify(p)} in ${marking}`);
  }
  return shapes;
}

/** Every shape the writer's property turns on, all named from the generator's lists. */
export const EVERY_SHAPE: readonly string[] = [
  ...[1, 2, 3, 4, 5, 6].map((level) => `heading ${level}`),
  ...[1, 3].map((start) => `ordered from ${start}`),
  ...[true, false].flatMap((yes) => [`task checked ${yes}`, `callout titled ${yes}`]),
  ...['listItem', 'taskItem', 'blockquote', 'callout'].flatMap((holder) =>
    NESTED.map((kind) => `${kind} in ${holder}`),
  ),
  ...TOP_KINDS.map((type) => `${type} in doc`),
  ...[...CAN_CARRY_AN_ID].flatMap((type) =>
    ['listItem', 'taskItem'].includes(type) ? [`id on ${type}`] : [`id on ${type} at top`],
  ),
  ...['paragraph', 'bulletList', 'orderedList', 'blockquote'].map((type) => `id on ${type}`),
  ...['wikiLink', 'image', 'hardBreak'].flatMap((inline) =>
    ['paragraph', 'heading'].map((block) => `${inline} in ${block}`),
  ),
  ...SRCS.map((src) => `image of ${src}`),
  'image alt none',
  'image alt some',
  ...EVERY_PIECE.map((p) => `${JSON.stringify(p)} in alt`),
  ...HREFS.map((href) => `link to ${href}`),
  ...TARGETS.flatMap((target) =>
    ['wikiLink', 'bookmark', 'blockEmbed'].map((type) => `${type} to ${target}`),
  ),
  ...['wikiLink', 'bookmark'].flatMap((type) =>
    ['#Part', 'null'].map((heading) => `${type} heading ${heading}`),
  ),
  ...EMBED_FRAGMENTS.map((fragment) => `blockEmbed heading ${fragment}`),
  ...[true, false].flatMap((yes) => [
    `wikiLink alias ${yes}`,
    `blockEmbed alias ${yes}`,
    `wikiLink embed ${yes}`,
  ]),
  ...LINK_MARKINGS.map((marking) => `wikiLink ${marking}`),
  ...CONTAINERS.map((container) => `line break in ${container}`),
  ...ADDRESSES.flatMap((address) =>
    MARKINGS.flatMap((marking) =>
      [
        ...ADDRESSES.map((other) => `before ${JSON.stringify(other)}`),
        'before a word',
        'after a word',
        'before markup',
        ...ADDRESSES.map((next) => `starts a line before ${JSON.stringify(next)}`),
      ].map((beside) => `${JSON.stringify(address)} ${beside} in ${marking}`),
    ),
  ),
  ...INLINE_KINDS.flatMap((first) => INLINE_KINDS.map((next) => `${next} after ${first}`)),
  ...TOP_KINDS.flatMap((first) => TOP_KINDS.map((next) => `${next} after ${first}`)),
  ...EVERY_PIECE.flatMap((p) => [
    ...MARKINGS.map((marking) => `${JSON.stringify(p)} in ${marking}`),
    ...CONTAINERS.flatMap((container) => [
      `${JSON.stringify(p)} starts ${container}`,
      `${JSON.stringify(p)} ends ${container}`,
    ]),
  ]),
];

/** The shapes in `EVERY_SHAPE` that none of `docs` holds. */
export function shapesNotIn(docs: readonly EditorDocument[], required = EVERY_SHAPE): string[] {
  const drawn = new Set(docs.flatMap((doc) => [...shapesOf(doc)]));
  return required.filter((shape) => !drawn.has(shape));
}
