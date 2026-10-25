import { LINK_FRAGMENT, LINK_PATH, resourceAttribute, STYLESHEET_PATH } from './chapter-safety.ts';
import type { BookFiles } from './book-files.ts';
import type { ChapterText } from './chapter-text.ts';
import type { FrameNode } from './frame-protocol.ts';

/*
 * A safe chapter as its frame is handed it (#505, ADR-0045): its nodes, in
 * document order, as plain data — the frame builds them itself, so nothing
 * of the book is ever parsed as markup there. Each picture, font and
 * stylesheet of the book that `makeChapterSafe` kept by its path is written
 * in as a `data:` address, and each stylesheet `<link>` becomes a `<style>`
 * in the same place. Each text node says where its words begin in the
 * chapter's text (`chapterText`), so the frame names a selection, and draws
 * a highlight, at the same offsets the reader does. Comments and the like
 * are left out: they show nothing and hold no words.
 */

const XHTML = 'http://www.w3.org/1999/xhtml';
const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;

/** The attributes a kept file's path is held under, and the attribute its address goes back in. */
const RESOURCES = ['src', 'href', 'poster', 'background', 'data'];

/** The only `data-dfai-…` attributes the frame is given: where a link of the book leads. */
const LINK_ATTRIBUTES = new Set([LINK_PATH, LINK_FRAGMENT]);

/** What a chapter's frame is handed: its nodes, and how long its text is. */
export interface ChapterSource {
  readonly nodes: FrameNode[];
  readonly length: number;
}

/** The safe chapter `chapter`, at `path` in the book, with `text` its text, as its frame is handed it. */
export async function chapterSource({
  chapter,
  text,
  path,
  files,
}: {
  chapter: Document;
  text: ChapterText;
  path: string;
  files: BookFiles;
}): Promise<ChapterSource> {
  const made = await madeFiles(chapter, path, files);
  const starts = new Map<Node, number>(text.runs.map((run) => [run.node, run.start]));
  const nodes: FrameNode[] = [];
  const pending: { node: Node; parent: number }[] = [{ node: chapter.documentElement, parent: -1 }];
  // Depth first, by hand: a book may nest deeper than the stack goes.
  while (pending.length > 0) {
    const { node, parent } = pending.pop() as { node: Node; parent: number };
    const index = nodes.length;
    if (!pushNode({ nodes, node, parent, starts, made })) continue;
    if (node.nodeType !== ELEMENT || made.css.has(node as Element)) continue;
    const children = Array.from(node.childNodes);
    for (let at = children.length - 1; at >= 0; at -= 1) {
      pending.push({ node: children[at] as Node, parent: index });
    }
  }
  return { nodes, length: text.length };
}

/** Each file the chapter loads, by its path, as its address; and each `<style>`'s and `style=`'s CSS, made. */
interface MadeFiles {
  readonly addresses: ReadonlyMap<string, string>;
  /** An element's CSS: its own `<style>`'s, or the stylesheet its `<link>` named. */
  readonly css: ReadonlyMap<Element, string>;
  readonly inline: ReadonlyMap<Element, string>;
}

async function madeFiles(chapter: Document, path: string, files: BookFiles): Promise<MadeFiles> {
  const addresses = new Map<string, string>();
  const css = new Map<Element, string>();
  const inline = new Map<Element, string>();
  const work: Promise<void>[] = [];
  // The chapter's CSS, made one piece at a time in document order: all of it shares one budget,
  // so what is dropped once it runs out is the same however the book's files load.
  const styling: (() => Promise<void>)[] = [];
  const budget = files.budget();
  for (const element of Array.from(chapter.getElementsByTagName('*'))) {
    for (const name of RESOURCES) {
      const kept = element.getAttribute(resourceAttribute(name));
      if (kept === null || addresses.has(kept)) continue;
      addresses.set(kept, '');
      work.push(files.address(kept).then((found) => void addresses.set(kept, found ?? '')));
    }
    const sheet = element.getAttribute(STYLESHEET_PATH);
    if (sheet !== null) {
      styling.push(async () => void css.set(element, await files.stylesheet(sheet, budget)));
    } else if (element.localName.toLowerCase() === 'style') {
      const text = element.textContent ?? '';
      styling.push(async () => void css.set(element, await files.css(text, path, budget)));
    }
    const style = element.getAttribute('style');
    if (style !== null) {
      styling.push(
        async () => void inline.set(element, await files.declarations(style, path, budget)),
      );
    }
  }
  work.push(
    (async () => {
      for (const made of styling) await made();
    })(),
  );
  await Promise.all(work);
  return { addresses, css, inline };
}

/** Adds `node`'s record; false when it is a node the frame is not given. */
function pushNode({
  nodes,
  node,
  parent,
  starts,
  made,
}: {
  nodes: FrameNode[];
  node: Node;
  parent: number;
  starts: ReadonlyMap<Node, number>;
  made: MadeFiles;
}): boolean {
  if (node.nodeType === TEXT || node.nodeType === CDATA) {
    nodes.push([parent, 3, (node as CharacterData).data, starts.get(node) ?? -1]);
    return true;
  }
  if (node.nodeType !== ELEMENT) return false;
  const element = node as Element;
  const css = made.css.get(element);
  if (css === undefined) {
    nodes.push([
      parent,
      1,
      element.namespaceURI ?? '',
      qualifiedName(element),
      attributesOf(element, made),
    ]);
    return true;
  }
  // A stylesheet's `<link>`, or a `<style>`, is given as a `<style>` holding its CSS made the book's own.
  const own = element.localName.toLowerCase() === 'style' ? attributesOf(element, made) : [];
  const at = nodes.length;
  nodes.push([parent, 1, XHTML, 'style', own], [at, 3, css, -1]);
  return true;
}

/** The element's name as it is written: an HTML document's `tagName` is in capitals, its `localName` is not. */
const qualifiedName = (element: Element): string =>
  element.prefix === null ? element.localName : `${element.prefix}:${element.localName}`;

/** The element's attributes as the frame builds them: each kept file back at its address, DFAI's own marks left out but a link's. */
function attributesOf(element: Element, made: MadeFiles): string[] {
  const attributes: string[] = [];
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name;
    if (name.startsWith('data-dfai-')) {
      if (LINK_ATTRIBUTES.has(name)) attributes.push('', name, attribute.value);
      continue;
    }
    const value = name === 'style' ? (made.inline.get(element) ?? '') : attribute.value;
    attributes.push(attribute.namespaceURI ?? '', name, value);
  }
  for (const name of RESOURCES) {
    const kept = element.getAttribute(resourceAttribute(name));
    const address = kept === null ? '' : (made.addresses.get(kept) ?? '');
    if (address !== '') attributes.push('', name, address);
  }
  return attributes;
}
