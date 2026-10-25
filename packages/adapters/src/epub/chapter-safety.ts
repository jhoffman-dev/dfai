import { bookReference } from '@dfai/domain';
import { addressesIn } from './css-references.ts';
import {
  getAttribute,
  getElementsByTagName,
  removeAttribute,
  shadowsAMember,
} from './unshadowed-dom.ts';

/*
 * A chapter of a book made safe to show (#505). A book is untrusted, so
 * before a chapter reaches its frame everything in it that could run,
 * load from outside the book, or lead out of it is taken away: scripts,
 * frames, plug-ins, `<base>`, `<meta>`, handlers, and references to other
 * sites. The frame's own policy (`epubFramePolicy`) and its opaque origin
 * refuse the same again (ADR-0045), so no one of them alone is relied on. What is taken away is put back as
 * an empty, hidden element of the same place, so the chapter keeps every
 * node where it was: an EPUB CFI counts a chapter's elements, and one made
 * here must name the same place in any other reader.
 *
 * Links and the book's own files are not followed here: a link inside the
 * book is kept as where it leads (`data-dfai-path`, `data-dfai-fragment`),
 * for the reader to go to; a picture, a stylesheet or a font of the book is
 * kept as its path in the archive (`data-dfai-…`), to be written into the
 * chapter as a `data:` address. Only `<a>` and `<area>` are links, and only
 * SVG's resource loaders may name a file by `href`: any other element's
 * `href` is dropped — WebKit follows a MathML element's, and once that led
 * the frame to a picture of the book holding a script. A `data-dfai-…` the
 * book writes itself is dropped too, so it cannot pose as one of these.
 */

const XHTML = 'http://www.w3.org/1999/xhtml';

/** Elements that run, embed, or point the document elsewhere: replaced by an empty, hidden one. */
const TAKEN_AWAY = new Set([
  'applet',
  'base',
  'embed',
  'frame',
  'frameset',
  'iframe',
  'meta',
  'object',
  'portal',
  'script',
]);

/** SVG animation, which can set a link's address after the chapter is made safe. */
const ANIMATION = new Set(['animate', 'animatemotion', 'animatetransform', 'set']);

/** Attributes that name a file the element loads: kept only when the file is the book's. */
const RESOURCE_ATTRIBUTES = ['src', 'poster', 'background', 'data'];

/** Attributes that send, open or load something no reader needs. */
const DROPPED_ATTRIBUTES = new Set([
  'action',
  'formaction',
  'http-equiv',
  'manifest',
  'ping',
  'srcset',
  'target',
]);

/** SVG elements that load what their `href` names: a picture, a shape to reuse, a paint server, a path for text. */
const SVG_LOADERS = new Set([
  'image',
  'use',
  'feimage',
  'pattern',
  'textpath',
  'lineargradient',
  'radialgradient',
]);

const SVG = 'http://www.w3.org/2000/svg';

/** What DFAI writes on an element: a book's own attribute of the same name is dropped before. */
const DFAI_ATTRIBUTE = 'data-dfai-';

/** Where a link or a file named in a chapter leads, kept on its element for the reader and the frame. */
export const LINK_PATH = 'data-dfai-path';
export const LINK_FRAGMENT = 'data-dfai-fragment';
/** The book's file an element's `src` (and so on) names, by its path in the archive. */
export const resourceAttribute = (attribute: string): string => `data-dfai-${attribute}`;
/** A stylesheet `<link>` of the book: its path, to be put in the chapter as a `<style>`. */
export const STYLESHEET_PATH = 'data-dfai-stylesheet';

/** Makes the chapter at `path` in the archive, parsed as `doc`, safe to show, in place. */
export function makeChapterSafe(doc: Document, path: string): void {
  dropShadowingNames(doc);
  for (const element of Array.from(doc.getElementsByTagName('*'))) {
    const name = element.localName.toLowerCase();
    if (TAKEN_AWAY.has(name) || (ANIMATION.has(name) && element.namespaceURI !== XHTML)) {
      element.replaceWith(emptyInPlaceOf(doc));
      continue;
    }
    if (name === 'link') {
      keepStylesheet(doc, element, path);
      continue;
    }
    for (const attribute of Array.from(element.attributes)) safeAttribute(element, attribute, path);
  }
}

/**
 * Takes away each `name` and `id` that shadows a member of the document or
 * a form (`<img name="body">`, `<input name="appendChild">`), through the
 * DOM's own members, before anything else reads the chapter: once they are
 * gone, the document's members are its own again, here and in the frame.
 */
function dropShadowingNames(doc: Document): void {
  for (const element of Array.from(getElementsByTagName(doc, '*'))) {
    for (const attribute of ['name', 'id']) {
      const value = getAttribute(element, attribute);
      if (value !== null && shadowsAMember(element, attribute, value)) {
        removeAttribute(element, attribute);
      }
    }
  }
}

/** An element that shows nothing and holds nothing: what is taken away leaves one behind. */
function emptyInPlaceOf(doc: Document): Element {
  const empty = doc.createElementNS(XHTML, 'span');
  empty.setAttribute('hidden', '');
  return empty;
}

/** A `<link>` to a stylesheet of the book is kept as its path; any other link is taken away. */
function keepStylesheet(doc: Document, link: Element, from: string): void {
  const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
  const target = bookReference({ from, ref: link.getAttribute('href') ?? '' });
  const empty = emptyInPlaceOf(doc);
  if (rel.includes('stylesheet') && target.kind === 'inside') {
    empty.setAttribute(STYLESHEET_PATH, target.path);
  }
  link.replaceWith(empty);
}

function safeAttribute(element: Element, attribute: Attr, from: string): void {
  const name = attribute.localName.toLowerCase();
  if (name.startsWith('on') || name.startsWith(DFAI_ATTRIBUTE) || DROPPED_ATTRIBUTES.has(name)) {
    element.removeAttributeNode(attribute);
  } else if (name === 'href') {
    keepLink(element, attribute, from);
  } else if (RESOURCE_ATTRIBUTES.includes(name)) {
    keepResource(element, attribute, from);
  } else if (name !== 'style' && namesOutsideAddress(attribute.value)) {
    element.removeAttributeNode(attribute);
  }
}

/**
 * Whether an attribute, read as CSS reads an SVG presentation attribute
 * (`fill`, `filter`, `mask`, `cursor`), names an address other than a place
 * in the chapter itself (`url(#id)`), or builds one from `var()`: a paint
 * server, filter or picture in another file is fetched. Read with CSS's own
 * tokenizing, so no spelling hides one.
 */
function namesOutsideAddress(value: string): boolean {
  const found = addressesIn(value);
  return found === null || found.some(({ ref }) => !ref.trim().startsWith('#'));
}

/**
 * An `href`. On a link (`<a>`, `<area>`, in HTML or SVG) it is kept as where
 * it leads inside the book, and points nowhere itself; on an SVG resource
 * loader it names a file to load, as `src` does, or a place in the chapter
 * (`#id`), kept as it is; on anything else it is dropped.
 */
function keepLink(element: Element, attribute: Attr, from: string): void {
  const name = element.localName.toLowerCase();
  if (name === 'a' || name === 'area') {
    keepBookLink(element, attribute, from);
  } else if (element.namespaceURI === SVG && SVG_LOADERS.has(name)) {
    if (!attribute.value.trim().startsWith('#')) keepResource(element, attribute, from);
  } else {
    element.removeAttributeNode(attribute);
  }
}

function keepBookLink(element: Element, attribute: Attr, from: string): void {
  const target = bookReference({ from, ref: attribute.value });
  element.removeAttributeNode(attribute);
  // A link still reads and looks like one, and goes nowhere: the reader follows the book's own.
  element.setAttribute('href', '#');
  if (target.kind !== 'inside') return;
  element.setAttribute(LINK_PATH, target.path);
  if (target.fragment !== null) element.setAttribute(LINK_FRAGMENT, target.fragment);
}

/** A file the element loads: the book's own is kept by its path, one written in (`data:`) as it is, anything else dropped. */
function keepResource(element: Element, attribute: Attr, from: string): void {
  const target = bookReference({ from, ref: attribute.value });
  if (target.kind === 'data') return;
  const name = attribute.localName.toLowerCase();
  element.removeAttributeNode(attribute);
  if (target.kind === 'inside') element.setAttribute(resourceAttribute(name), target.path);
}
