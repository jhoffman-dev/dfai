import type { FrameNode, FramePaintGroup, FrameSelection, FromFrame } from './frame-protocol.ts';
import { offsetAt, rangeAt, type Run, type TextRuns } from './text-positions.ts';
import {
  appendChild,
  closest,
  createElementNS,
  createTextNode,
  documentElementOf,
  getAttribute,
  getElementById,
  localNameOf,
  namespaceOf,
  nodeTypeOf,
  querySelector,
  replaceChild,
  scrollIntoView,
  setAdoptedStyleSheets,
  setAttribute,
  setAttributeNS,
  shadowsAMember,
} from './unshadowed-dom.ts';

/*
 * DFAI's own script in a chapter's frame (#505, ADR-0045): the one script the
 * frame's policy lets run, named there by its hash. The frame's origin is
 * opaque, so the reader cannot reach in; this builds the chapter the reader
 * hands it, draws what the reader asks, and tells the reader what the person
 * does — as offsets of the chapter's text and paths of the book, never as
 * markup. It takes nothing on trust: a message from anyone but the reader,
 * or one that does not fit its shape and limits, is dropped; an element that
 * could run or load something, an attribute that could, and an address that
 * is not written into the chapter (`data:`) are not built, whatever the
 * reader's own cleaning missed. Every click is stopped: a link of the book
 * is followed by the reader, by the path the cleaning wrote on it.
 *
 * The chapter is the frame's document, so a name in it can shadow the
 * document's own members (`<img name="createRange">`): every call on the
 * document or on a built node goes through `unshadowed-dom.ts`, read as the
 * script starts, and a name or id that would shadow a member is not built.
 *
 * tools/epub/frame-bootstrap.ts turns this file, `text-positions.ts` and
 * `unshadowed-dom.ts` into the frame's script, so none imports anything but
 * types and the others.
 */

/** What the reader's cleaning writes on a link of the book: the book's file it leads to, and the place in it. */
const LINK_PATH = 'data-dfai-path';
const LINK_FRAGMENT = 'data-dfai-fragment';

/** The most nodes, ranges and characters one message may hold: far past any real chapter, short of a frozen frame. */
const MOST_NODES = 2_000_000;
const MOST_STRING = 32 * 1024 * 1024;
const MOST_RANGE_NUMBERS = 400_000;
const MOST_GROUPS = 64;
const MOST_PATH = 2048;
const MOST_NAME = 256;

/** A highlight's name, as the reader's styles name it (`dfai-highlight-yellow`). */
const HIGHLIGHT_NAME = /^dfai-[a-z0-9-]{1,48}$/;

const SVG = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';
const XMLNS = 'http://www.w3.org/2000/xmlns/';

/** Elements that run, embed, load or point the document elsewhere: an empty, hidden one is built instead. */
const REFUSED_ELEMENTS = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'applet',
  'base',
  'embed',
  'frame',
  'frameset',
  'iframe',
  'link',
  'meta',
  'object',
  'portal',
  'script',
  'set',
]);

/** Attributes that send, open or load something no reader needs. */
const REFUSED_ATTRIBUTES = new Set([
  'action',
  'formaction',
  'http-equiv',
  'manifest',
  'ping',
  'srcdoc',
  'srcset',
  'target',
]);

/** Attributes that load a file: only one written into the chapter (`data:`) is built. */
const RESOURCE_ATTRIBUTES = new Set(['src', 'poster', 'background', 'data']);

/** SVG elements that load what their `href` names: the only ones besides a link that keep one. */
const SVG_LOADERS = new Set([
  'image',
  'use',
  'feimage',
  'pattern',
  'textpath',
  'lineargradient',
  'radialgradient',
]);

type FrameWindow = Window & typeof globalThis;

/** What the frame holds between messages: the chapter's text nodes, once it is built. */
interface FrameState {
  chapter: TextRuns | null;
}

/** Starts DFAI's side of the frame in `view`, talking only with `reader`, the window that made it. */
export function startFrame(view: FrameWindow, reader: Window): void {
  const state: FrameState = { chapter: null };
  const send = (message: FromFrame) => reader.postMessage(message, '*');
  view.addEventListener('message', (event) => {
    if (event.source !== reader) return;
    receive(view, state, event.data, send);
  });
  listenToThePerson(view, state, send);
  send({ kind: 'ready' });
}

function receive(
  view: FrameWindow,
  state: FrameState,
  message: unknown,
  send: (message: FromFrame) => void,
): void {
  if (typeof message !== 'object' || message === null) return;
  const said = message as Record<string, unknown>;
  switch (said['kind']) {
    case 'chapter':
      // One chapter per frame: another is the reader's to show in a new one.
      if (state.chapter !== null) return;
      state.chapter = buildChapter(view.document, said['nodes'], said['length']);
      if (state.chapter !== null) send({ kind: 'shown' });
      return;
    case 'style':
      setStyle(view, said['css']);
      return;
    case 'paint':
      if (state.chapter !== null) paint(view, state.chapter, said);
      return;
    default:
      scroll(view, state, said);
  }
}

/** The scrolls and the selection's clearing the reader asks for. */
function scroll(view: FrameWindow, state: FrameState, said: Record<string, unknown>): void {
  if (said['kind'] === 'clear-selection') {
    view.getSelection()?.removeAllRanges();
  } else if (said['kind'] === 'scroll-to-offset' && state.chapter !== null) {
    const offset = said['offset'];
    if (!isOffset(offset, state.chapter.length)) return;
    const box = rangeAt(state.chapter, offset, offset)?.getBoundingClientRect();
    if (box !== undefined) view.scrollTo({ top: Math.max(0, view.scrollY + box.top - 80) });
  } else if (said['kind'] === 'scroll-to-fragment') {
    const fragment = said['fragment'];
    if (fragment !== null && !isShortString(fragment, MOST_PATH)) return;
    scrollToFragment(view, fragment);
  }
}

function scrollToFragment(view: FrameWindow, fragment: string | null): void {
  const doc = view.document;
  const target =
    fragment === null || fragment === ''
      ? null
      : (getElementById(doc, fragment) ??
        querySelector(doc, `[name="${view.CSS.escape(fragment)}"]`));
  if (target === null) view.scrollTo({ top: 0 });
  else scrollIntoView(target, { block: 'start' });
}

const isShortString = (value: unknown, most: number): value is string =>
  typeof value === 'string' && value.length <= most;

const isOffset = (value: unknown, length: number): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= length;

/**
 * Builds the chapter from its nodes as the document's root, in place of the
 * frame's own; null, and nothing built, when they are not a chapter.
 */
export function buildChapter(doc: Document, nodes: unknown, length: unknown): TextRuns | null {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MOST_NODES) return null;
  if (!Number.isInteger(length) || (length as number) < 0) return null;
  const built: Node[] = [];
  const runs: Run[] = [];
  for (const [index, record] of nodes.entries()) {
    const node = nodeOf(doc, record);
    built.push(node);
    if (index > 0) attach({ built, index, record, node });
    const start = nodeTypeOf(node) === 3 ? (record as FrameNode)[3] : -1;
    if (typeof start === 'number' && isRunStart(start, runs, length as number)) {
      runs.push({ node: node as Text, start });
    }
  }
  const root = built[0];
  const current = documentElementOf(doc);
  if (root === undefined || nodeTypeOf(root) !== 1 || current === null) return null;
  replaceChild(doc, root, current);
  return { runs, length: length as number };
}

/** A run begins inside the text, and after the one before: the runs are in document order. */
const isRunStart = (start: number, runs: readonly Run[], length: number): boolean =>
  Number.isInteger(start) && start >= 0 && start <= length && start >= (runs.at(-1)?.start ?? 0);

/** Puts node `index` into its parent, an element built before it; a node with no such parent is left out. */
function attach({
  built,
  index,
  record,
  node,
}: {
  built: readonly Node[];
  index: number;
  record: unknown;
  node: Node;
}): void {
  const at = Array.isArray(record) ? (record[0] as number) : -1;
  const parent = at >= 0 && at < index ? built[at] : undefined;
  if (parent === undefined || nodeTypeOf(parent) !== 1) return;
  appendChild(parent, node);
}

/** The node a record names: an element, a text, or an empty text for anything else. */
function nodeOf(doc: Document, record: unknown): Node {
  if (!Array.isArray(record) || !Number.isInteger(record[0])) return createTextNode(doc, '');
  if (record[1] === 3 && isShortString(record[2], MOST_STRING))
    return createTextNode(doc, record[2]);
  if (record[1] !== 1) return createTextNode(doc, '');
  const [, , namespace, name, attributes] = record as unknown[];
  if (!isShortString(namespace, MOST_NAME) || !isShortString(name, MOST_NAME)) return hidden(doc);
  const element = elementOf(doc, namespace, name);
  if (Array.isArray(attributes)) setAttributes(element, attributes);
  return element;
}

function elementOf(doc: Document, namespace: string, name: string): Element {
  const local = name.slice(name.indexOf(':') + 1).toLowerCase();
  if (REFUSED_ELEMENTS.has(local)) return hidden(doc);
  try {
    return createElementNS(doc, namespace === '' ? null : namespace, name);
  } catch {
    // A name the DOM refuses (the book's HTML allowed it): an empty element keeps its place.
    return hidden(doc);
  }
}

function hidden(doc: Document): Element {
  const empty = createElementNS(doc, XHTML, 'span');
  setAttribute(empty, 'hidden', '');
  return empty;
}

function setAttributes(element: Element, attributes: readonly unknown[]): void {
  for (let at = 0; at + 2 < attributes.length; at += 3) {
    const [namespace, name, value] = [attributes[at], attributes[at + 1], attributes[at + 2]];
    if (!isShortString(namespace, MOST_NAME) || !isShortString(name, MOST_NAME)) continue;
    if (!isShortString(value, MOST_STRING) || !isAllowed({ element, namespace, name, value })) {
      continue;
    }
    try {
      setAttributeNS({ element, namespace: namespace === '' ? null : namespace, name, value });
    } catch {
      // A name the DOM refuses is an attribute no reader needs.
    }
  }
}

/** Whether an attribute may be built: nothing that runs, sends or loads from anywhere but the chapter itself. */
function isAllowed({
  element,
  namespace,
  name,
  value,
}: {
  element: Element;
  namespace: string;
  name: string;
  value: string;
}): boolean {
  const local = name.slice(name.indexOf(':') + 1).toLowerCase();
  if (namespace === XMLNS || local === 'xmlns' || local.startsWith('on')) return false;
  if (REFUSED_ATTRIBUTES.has(local)) return false;
  if (namespace === '' && shadowsAMember(element, name, value)) return false;
  if (local === 'href') return isAllowedHref(element, value.trim());
  if (RESOURCE_ATTRIBUTES.has(local)) return /^data:/i.test(value.trim());
  return true;
}

/** A link's `href` points nowhere (`#`); an SVG loader's names a place in the chapter or a file written in. */
function isAllowedHref(element: Element, value: string): boolean {
  const tag = localNameOf(element).toLowerCase();
  if (tag === 'a' || tag === 'area') return value === '#';
  if (namespaceOf(element) !== SVG || !SVG_LOADERS.has(tag)) return false;
  return value.startsWith('#') || /^data:/i.test(value);
}

/** The reader's styles, set as the frame's own sheet: they are not written into the chapter. */
function setStyle(view: FrameWindow, css: unknown): void {
  if (!isShortString(css, MOST_STRING)) return;
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(css);
  setAdoptedStyleSheets(view.document, [sheet]);
}

/** Draws the reader's highlights with the CSS Custom Highlight API, which marks text without adding a node. */
function paint(view: FrameWindow, chapter: TextRuns, said: Record<string, unknown>): void {
  if (typeof view.Highlight !== 'function' || typeof view.CSS?.highlights !== 'object') return;
  const clear = readClear(said['clear']);
  const groups = readGroups(said['groups'], clear, chapter.length);
  if (clear === null || groups === null) return;
  const registry = view.CSS.highlights;
  const drawn = new Set(groups.map((group) => group.name));
  for (const name of [...registry.keys()]) {
    if (clear.some((prefix) => name.startsWith(prefix)) && !drawn.has(name)) registry.delete(name);
  }
  for (const group of groups) {
    const ranges: Range[] = [];
    for (let at = 0; at + 1 < group.ranges.length; at += 2) {
      const range = rangeAt(chapter, group.ranges[at] as number, group.ranges[at + 1] as number);
      if (range !== null) ranges.push(range);
    }
    const highlight = new view.Highlight(...ranges);
    highlight.priority = group.priority;
    registry.set(group.name, highlight);
  }
}

function readClear(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MOST_GROUPS) return null;
  return value.every((prefix) => isShortString(prefix, 64) && /^dfai-[a-z0-9-]*$/.test(prefix))
    ? (value as string[])
    : null;
}

/** The groups to draw, each under a name the paint clears; null when any does not fit. */
function readGroups(
  value: unknown,
  clear: readonly string[] | null,
  length: number,
): FramePaintGroup[] | null {
  if (clear === null || !Array.isArray(value) || value.length > MOST_GROUPS) return null;
  const groups: FramePaintGroup[] = [];
  for (const group of value as unknown[]) {
    if (typeof group !== 'object' || group === null) return null;
    const { name, priority, ranges } = group as Record<string, unknown>;
    if (!isShortString(name, 64) || !HIGHLIGHT_NAME.test(name)) return null;
    if (!clear.some((prefix) => name.startsWith(prefix))) return null;
    if (priority !== 0 && priority !== 1) return null;
    if (!Array.isArray(ranges) || ranges.length > MOST_RANGE_NUMBERS) return null;
    if (!ranges.every((offset) => isOffset(offset, length))) return null;
    groups.push({ name, priority, ranges: ranges as number[] });
  }
  return groups;
}

/** What the person does in the frame, told to the reader; a click never navigates the frame. */
function listenToThePerson(
  view: FrameWindow,
  state: FrameState,
  send: (message: FromFrame) => void,
): void {
  // Listened for as the frame starts, before any chapter can name a member of the document.
  const doc = view.document;
  const selection = (cause: 'end' | 'scroll') =>
    send({ kind: 'selection', cause, selection: selectionOf(view, state.chapter) });
  view.addEventListener('click', (event) => followLink(event, send), true);
  view.addEventListener('auxclick', (event) => event.preventDefault(), true);
  view.addEventListener('submit', (event) => event.preventDefault(), true);
  doc.addEventListener('mouseup', () => selection('end'));
  doc.addEventListener('keyup', () => selection('end'));
  doc.addEventListener('keydown', (event) => {
    // ⌘F is the reader's find, not the frame's.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') event.preventDefault();
    send({
      kind: 'key',
      key: event.key.slice(0, 32),
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
    });
  });
  view.addEventListener('scroll', () => selection('scroll'), { passive: true });
}

/** Stops every click; one on a link the reader's cleaning marked is told to the reader to follow. */
function followLink(event: MouseEvent, send: (message: FromFrame) => void): void {
  event.preventDefault();
  // A click's target is a node of the frame's document: no script but this one runs there.
  const target = event.target as Node | null;
  const link =
    target !== null && nodeTypeOf(target) === 1 ? closest(target as Element, 'a, area') : null;
  const path = link === null ? null : getAttribute(link, LINK_PATH);
  if (link === null || path === null || path === '') return;
  send({
    kind: 'link',
    path: path.slice(0, MOST_PATH),
    fragment: getAttribute(link, LINK_FRAGMENT)?.slice(0, MOST_PATH) ?? null,
  });
}

/** The words selected, as offsets of the chapter's text, and their box in the frame's viewport; null when none. */
function selectionOf(view: FrameWindow, chapter: TextRuns | null): FrameSelection | null {
  const selected = view.getSelection();
  if (chapter === null || selected === null || selected.rangeCount === 0 || selected.isCollapsed) {
    return null;
  }
  const range = selected.getRangeAt(0);
  const start = offsetAt(chapter, range.startContainer, range.startOffset);
  const end = offsetAt(chapter, range.endContainer, range.endOffset);
  if (start >= end) return null;
  const box = range.getBoundingClientRect();
  return {
    start,
    end,
    rect: { left: box.left, top: box.top, width: box.width, height: box.height },
  };
}
