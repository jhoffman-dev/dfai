import type { Run, TextRuns } from './text-positions.ts';
import {
  bodyOf as unshadowedBody,
  documentElementOf,
  getElementsByTagNameNS,
} from './unshadowed-dom.ts';

/*
 * A chapter's text as the EPUB reader counts it (#505): the words of its
 * body in document order, a line break where a block of text (a paragraph,
 * a heading, a list item) begins or ends, and nothing a reader does not
 * show — scripts, styles, the head. Every place the reader names in a
 * chapter — a selection, a highlight, a match of find — is an offset of
 * this text, and is turned into a DOM position and back by
 * `text-positions.ts`, on the parsed chapter or in the chapter's frame.
 */

/** Elements whose text is never shown. */
const UNSHOWN = new Set(['head', 'script', 'style', 'template', 'noscript', 'title']);

/** Elements that start a block of their own: their text is set apart from what is around it. */
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

/** A chapter's text, and the text nodes it was read from. */
export interface ChapterText extends TextRuns {
  readonly text: string;
}

/** The text of the chapter `doc` holds, read from its body (or its root, for a chapter with none). */
export function chapterText(doc: Document): ChapterText {
  const root = bodyOf(doc);
  const runs: Run[] = [];
  let text = '';
  const breakLine = () => {
    if (text !== '' && !text.endsWith('\n')) text += '\n';
  };
  const walk = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      const value = (node as Text).data;
      if (value === '') return;
      runs.push({ node: node as Text, start: text.length });
      text += value;
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const name = (node as Element).localName.toLowerCase();
    if (UNSHOWN.has(name)) return;
    const block = BLOCKS.has(name);
    if (block) breakLine();
    for (let child = node.firstChild; child !== null; child = child.nextSibling) walk(child);
    if (block) breakLine();
  };
  walk(root);
  return { text, runs, length: text.length };
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** The chapter's body, read through the DOM's own members: a book's `<img name="body">` is not it. */
function bodyOf(doc: Document): Node {
  const body =
    unshadowedBody(doc) ?? getElementsByTagNameNS(doc, 'http://www.w3.org/1999/xhtml', 'body')[0];
  return body ?? documentElementOf(doc) ?? doc;
}
