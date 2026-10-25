/*
 * What the reader and a chapter's frame say to each other (#505, ADR-0045).
 * The frame has an opaque origin, so they talk only by `postMessage`: the
 * reader hands it the chapter — already made safe, as a list of nodes, the
 * book's files written in as `data:` — and what to draw; the frame answers
 * with what the person did, as offsets of the chapter's text and paths of
 * the book. Neither side takes the other's word for anything: each message
 * is read against its shape and its limits, and one that does not fit is
 * dropped. The frame never hands back markup.
 */

/** An element of the chapter: its parent's index in the list (-1 for the root), namespace, qualified name, and attributes as `[namespace, name, value]` triples, flat. */
export type FrameElement = readonly [
  parent: number,
  kind: 1,
  namespace: string,
  name: string,
  attributes: readonly string[],
];

/** A text of the chapter: its parent's index, its words, and where they begin in the chapter's text (-1 when the reader does not count them). */
export type FrameText = readonly [parent: number, kind: 3, data: string, start: number];

/** The chapter as the frame builds it: its nodes in document order, each after its parent. */
export type FrameNode = FrameElement | FrameText;

/** A set of highlights drawn under one name: its ranges as flat `[start, end)` pairs of the chapter's text. */
export interface FramePaintGroup {
  readonly name: string;
  /** 1 draws it over the ones at 0. */
  readonly priority: 0 | 1;
  readonly ranges: readonly number[];
}

/** What the reader tells the frame. */
export type ToFrame =
  | {
      readonly kind: 'chapter';
      readonly nodes: readonly FrameNode[];
      /** How long the chapter's text is: every offset of it is at most this. */
      readonly length: number;
    }
  | { readonly kind: 'style'; readonly css: string }
  | {
      readonly kind: 'paint';
      /** The names, by prefix, this paint replaces: each is taken away unless drawn again. */
      readonly clear: readonly string[];
      readonly groups: readonly FramePaintGroup[];
    }
  | { readonly kind: 'scroll-to-offset'; readonly offset: number }
  | { readonly kind: 'scroll-to-fragment'; readonly fragment: string | null }
  | { readonly kind: 'clear-selection' };

/** The selection in the frame: offsets of the chapter's text, and its box in the frame's viewport. */
export interface FrameSelection {
  readonly start: number;
  readonly end: number;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

/** What the frame tells the reader. */
export type FromFrame =
  /** DFAI's script runs in the frame and listens. */
  | { readonly kind: 'ready' }
  /** The chapter is built and on screen. */
  | { readonly kind: 'shown' }
  /** A press or a key was let go (`end`) or the frame scrolled (`scroll`): the selection as it now is. */
  | {
      readonly kind: 'selection';
      readonly cause: 'end' | 'scroll';
      readonly selection: FrameSelection | null;
    }
  /** A link of the book was clicked: the book's file it leads to, and the place in it. */
  | { readonly kind: 'link'; readonly path: string; readonly fragment: string | null }
  /** A key was pressed in the frame. */
  | {
      readonly kind: 'key';
      readonly key: string;
      readonly meta: boolean;
      readonly ctrl: boolean;
      readonly shift: boolean;
      readonly alt: boolean;
    };

/** The longest path or fragment a link of a book may name: far past any real one. */
export const MOST_PATH = 2048;
/** The longest key name (`ArrowRight`, `F12`, `a`). */
export const MOST_KEY = 32;
/** How far off the frame's viewport a selection's box may be said to be, in CSS pixels. */
const MOST_COORDINATE = 10_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isShortString = (value: unknown, most: number): value is string =>
  typeof value === 'string' && value.length <= most;

const isOffset = (value: unknown, textLength: number): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= textLength;

/**
 * What the frame said, if it is a message of this protocol that fits its
 * limits; null for anything else. `textLength` is the length of the shown
 * chapter's text: a selection outside it is no selection of this chapter.
 */
export function readFrameMessage(data: unknown, textLength: number): FromFrame | null {
  if (!isRecord(data)) return null;
  switch (data['kind']) {
    case 'ready':
    case 'shown':
      return { kind: data['kind'] };
    case 'selection':
      return readSelectionMessage(data, textLength);
    case 'link':
      return readLink(data);
    case 'key':
      return readKey(data);
    default:
      return null;
  }
}

function readSelectionMessage(data: Record<string, unknown>, textLength: number): FromFrame | null {
  const cause = data['cause'];
  if (cause !== 'end' && cause !== 'scroll') return null;
  if (data['selection'] === null) return { kind: 'selection', cause, selection: null };
  const selection = readSelection(data['selection'], textLength);
  return selection === null ? null : { kind: 'selection', cause, selection };
}

function readSelection(value: unknown, textLength: number): FrameSelection | null {
  if (!isRecord(value) || !isRecord(value['rect'])) return null;
  const { start, end } = value;
  if (!isOffset(start, textLength) || !isOffset(end, textLength) || start >= end) return null;
  const rect = value['rect'];
  const box = [rect['left'], rect['top'], rect['width'], rect['height']];
  if (
    !box.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MOST_COORDINATE)
  ) {
    return null;
  }
  const [left, top, width, height] = box as number[];
  return { start, end, rect: { left: left!, top: top!, width: width!, height: height! } };
}

function readLink(data: Record<string, unknown>): FromFrame | null {
  const { path, fragment } = data;
  if (!isShortString(path, MOST_PATH) || path === '') return null;
  if (fragment !== null && !isShortString(fragment, MOST_PATH)) return null;
  return { kind: 'link', path, fragment };
}

function readKey(data: Record<string, unknown>): FromFrame | null {
  const { key, meta, ctrl, shift, alt } = data;
  if (!isShortString(key, MOST_KEY) || key === '') return null;
  const flags = [meta, ctrl, shift, alt];
  if (!flags.every((flag) => typeof flag === 'boolean')) return null;
  return {
    kind: 'key',
    key,
    meta: meta as boolean,
    ctrl: ctrl as boolean,
    shift: shift as boolean,
    alt: alt as boolean,
  };
}
