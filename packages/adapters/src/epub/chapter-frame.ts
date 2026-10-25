import {
  EPUB_FRAME_SANDBOX,
  epubFramePolicy,
  type HighlightColor,
  type HighlightStyle,
} from '@dfai/domain';
import type { ChapterSource } from './chapter-source.ts';
import { yieldToHost } from './yield-to-host.ts';
import { FRAME_BOOTSTRAP, FRAME_BOOTSTRAP_SHA256 } from './frame-bootstrap.generated.ts';
import {
  readFrameMessage,
  type FramePaintGroup,
  type FrameSelection,
  type FromFrame,
  type ToFrame,
} from './frame-protocol.ts';

/*
 * A chapter shown in a frame of its own (#505, ADR-0045). The frame's origin
 * is opaque (`EPUB_FRAME_SANDBOX`): nothing in it can reach the app, and the
 * app does not reach in. Its document is DFAI's — the policy first, then
 * DFAI's one script, named in the policy by its hash — and the chapter is
 * handed to that script as data (`chapterSource`), with the reader's styles
 * and what to draw; it answers with the selection, the links followed, the
 * keys pressed and the scrolling, which are read against the protocol
 * (`readFrameMessage`) before anything is done with them. Highlights and
 * find's matches are drawn there with the CSS Custom Highlight API, which
 * marks text without adding a node.
 */

/** How the book looks: the reader's colours, read from its own theme. */
export interface ChapterAppearance {
  /** The text's size, as a percentage of the book's own. */
  readonly fontSize: number;
  /** Dark: the book's own colours give way to the window's, so it reads on a dark page. */
  readonly scheme: 'light' | 'dark';
  readonly ink: string;
  readonly page: string;
  readonly link: string;
  /** Each highlight colour's fill, and the line an underline is drawn with. */
  readonly marks: Readonly<
    Record<HighlightColor, { readonly fill: string; readonly line: string }>
  >;
  /** The ink on a highlight's fill, which is pale in every theme. */
  readonly markInk: string;
  readonly flash: string;
  readonly found: string;
  readonly foundCurrent: string;
}

/** A highlight drawn in the chapter: `[start, end)` of its text, and its style. */
export interface ChapterMark {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly style: HighlightStyle;
}

/** What the person does in the frame that the reader acts on. */
export interface ChapterEvents {
  /** A link inside the book was followed: the book's file it leads to, and the place in it. */
  onLink(target: { path: string; fragment: string | null }): void;
  /** A press or a key let go: the selection may have changed. */
  onSelectionEnd(): void;
  /** A key pressed in the frame, which the reader's own shortcuts (⌘F) may want. */
  onKeyDown(event: KeyboardEvent): void;
  onScroll(): void;
}

/** A chapter on screen, for the reader to draw in, read the selection of, and scroll. */
export interface ShownChapter {
  /** The words selected in the chapter, as offsets of its text, and where they are on screen; null when none. */
  selection(): { start: number; end: number; rect: DOMRect } | null;
  clearSelection(): void;
  /** Draws these highlights, `flashing` lit for a moment; the ones drawn before are taken away. */
  paint(marks: readonly ChapterMark[], flashing: string | null): void;
  /** Draws find's matches, the current one apart. */
  paintFound(found: readonly { start: number; end: number }[], current: number | null): void;
  /** Brings offset `offset` of the chapter's text into view. */
  scrollToOffset(offset: number): void;
  /** Brings the element `#fragment` names into view, or the top when there is none. */
  scrollToFragment(fragment: string | null): void;
  setAppearance(appearance: ChapterAppearance): void;
  /** Takes the frame away. */
  destroy(): void;
}

/** The document the frame starts as: the policy first, then DFAI's script, before anything of the book. */
export const FRAME_SHELL = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${epubFramePolicy(FRAME_BOOTSTRAP_SHA256)}"><script>${FRAME_BOOTSTRAP}</script></head><body></body></html>`;

/** Shows `chapter` (made safe, as its frame is handed it) in a new frame inside `host`. */
export async function showChapter({
  host,
  chapter,
  appearance,
  events,
}: {
  host: HTMLElement;
  chapter: ChapterSource;
  appearance: ChapterAppearance;
  events: ChapterEvents;
}): Promise<ShownChapter> {
  const frame = host.ownerDocument.createElement('iframe');
  frame.className = 'epub-frame';
  frame.title = 'Book text';
  frame.setAttribute('sandbox', EPUB_FRAME_SANDBOX);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = FRAME_SHELL;
  const link = frameLink(frame, chapter.length);
  try {
    const ready = whenReady(frame, link);
    host.append(frame);
    await ready;
    link.post({ kind: 'style', css: readerCss(appearance) });
    const shown = link.next('shown');
    link.post({ kind: 'chapter', nodes: chapter.nodes, length: chapter.length });
    await shown;
  } catch (error) {
    link.close();
    frame.remove();
    throw error;
  }
  return shownChapter({ frame, link, events, length: chapter.length });
}

/** The reader's side of the frame's messages: only the frame's own, and only those that fit the protocol. */
export interface FrameLink {
  post(message: ToFrame): void;
  /** Resolves on the frame's next message of `kind`. */
  next(kind: FromFrame['kind']): Promise<void>;
  listen(handler: (message: FromFrame) => void): void;
  close(): void;
}

function frameLink(frame: HTMLIFrameElement, length: number): FrameLink {
  const view = frame.ownerDocument.defaultView;
  const handlers = new Set<(message: FromFrame) => void>();
  const onMessage = (event: MessageEvent) => {
    // The frame's origin is opaque, so it says `null`; a message from any other window is not the frame's.
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    const message = readFrameMessage(event.data, length);
    if (message !== null) for (const handler of [...handlers]) handler(message);
  };
  view?.addEventListener('message', onMessage);
  return {
    post: (message) => frame.contentWindow?.postMessage(message, '*'),
    next: (kind) =>
      new Promise((resolve) => {
        const once = (message: FromFrame) => {
          if (message.kind !== kind) return;
          handlers.delete(once);
          resolve();
        };
        handlers.add(once);
      }),
    listen: (handler) => void handlers.add(handler),
    close: () => {
      handlers.clear();
      view?.removeEventListener('message', onMessage);
    },
  };
}

/**
 * Resolves once DFAI's script in the frame says it listens. It runs while the
 * frame's document is read, so its word is posted before the frame loads;
 * none a task after the load means it never ran (a policy that refused it).
 */
function whenReady(frame: HTMLIFrameElement, link: FrameLink): Promise<void> {
  let ready = false;
  return new Promise((resolve, reject) => {
    void link.next('ready').then(() => {
      ready = true;
      resolve();
    });
    frame.addEventListener(
      'load',
      () =>
        void yieldToHost().then(() => {
          if (!ready) reject(new Error('The book could not be shown: its frame did not start.'));
        }),
      { once: true },
    );
  });
}

/** The chapter on screen in `frame`: what the frame says, turned into the reader's events; what the reader asks, sent. */
export function shownChapter({
  frame,
  link,
  events,
  length,
}: {
  frame: HTMLIFrameElement;
  link: FrameLink;
  events: ChapterEvents;
  length: number;
}): ShownChapter {
  let selected: FrameSelection | null = null;
  link.listen((message) => {
    if (message.kind === 'selection') {
      selected = message.selection;
      if (message.cause === 'end') events.onSelectionEnd();
      else events.onScroll();
    } else if (message.kind === 'link') {
      events.onLink({ path: message.path, fragment: message.fragment });
    } else if (message.kind === 'key') {
      events.onKeyDown(keyEventOf(message));
    }
  });
  return {
    selection: () => (selected === null ? null : onScreen(frame, selected)),
    clearSelection() {
      selected = null;
      link.post({ kind: 'clear-selection' });
    },
    paint: (marks, flashing) => link.post(markPaint({ marks, flashing, length })),
    paintFound: (found, current) => link.post(foundPaint({ found, current, length })),
    scrollToOffset: (offset) => link.post({ kind: 'scroll-to-offset', offset }),
    scrollToFragment: (fragment) => link.post({ kind: 'scroll-to-fragment', fragment }),
    setAppearance: (appearance) => link.post({ kind: 'style', css: readerCss(appearance) }),
    destroy() {
      link.close();
      frame.remove();
    },
  };
}

/** The selection's box on the reader's page: the frame's own box, and the selection's within it. */
function onScreen(frame: HTMLIFrameElement, selected: FrameSelection) {
  const at = frame.getBoundingClientRect();
  const { left, top, width, height } = selected.rect;
  return {
    start: selected.start,
    end: selected.end,
    rect: new DOMRect(at.left + left, at.top + top, width, height),
  };
}

/** A key the frame told of, as the reader's shortcuts read one; it is the frame's to stop, not the reader's. */
function keyEventOf(message: Extract<FromFrame, { kind: 'key' }>): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: message.key,
    metaKey: message.meta,
    ctrlKey: message.ctrl,
    shiftKey: message.shift,
    altKey: message.alt,
    cancelable: true,
  });
}

/** The highlights the frame's registry holds under DFAI's names, so a repaint takes away only its own. */
const MARK_PREFIX = 'dfai-';

/** The paint of the chapter's highlights: each style's ranges under its name, the lit one again over them. */
export function markPaint({
  marks,
  flashing,
  length,
}: {
  marks: readonly ChapterMark[];
  flashing: string | null;
  length: number;
}): ToFrame {
  const groups = new Map<string, FramePaintGroup & { ranges: number[] }>();
  for (const mark of marks) {
    if (!inChapter(mark, length)) continue;
    const name = `${MARK_PREFIX}${mark.style.mark}-${mark.style.color}`;
    groupInto(groups, { name, priority: 0, start: mark.start, end: mark.end });
    if (mark.id === flashing) {
      groupInto(groups, {
        name: `${MARK_PREFIX}flash`,
        priority: 1,
        start: mark.start,
        end: mark.end,
      });
    }
  }
  return {
    kind: 'paint',
    clear: [`${MARK_PREFIX}highlight-`, `${MARK_PREFIX}underline-`, `${MARK_PREFIX}flash`],
    groups: [...groups.values()],
  };
}

/** The paint of find's matches in the chapter, the current one apart and over the rest. */
export function foundPaint({
  found,
  current,
  length,
}: {
  found: readonly { start: number; end: number }[];
  current: number | null;
  length: number;
}): ToFrame {
  const groups = new Map<string, FramePaintGroup & { ranges: number[] }>();
  for (const [at, match] of found.entries()) {
    if (!inChapter(match, length)) continue;
    const name = `${MARK_PREFIX}found${at === current ? '-current' : ''}`;
    groupInto(groups, {
      name,
      priority: at === current ? 1 : 0,
      start: match.start,
      end: match.end,
    });
  }
  return { kind: 'paint', clear: [`${MARK_PREFIX}found`], groups: [...groups.values()] };
}

/** A stretch the frame can draw: within the chapter's text, and not backwards. */
const inChapter = ({ start, end }: { start: number; end: number }, length: number) =>
  Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;

function groupInto(
  groups: Map<string, FramePaintGroup & { ranges: number[] }>,
  { name, priority, start, end }: { name: string; priority: 0 | 1; start: number; end: number },
): void {
  const group = groups.get(name);
  if (group === undefined) groups.set(name, { name, priority, ranges: [start, end] });
  else group.ranges.push(start, end);
}

/** The reader's styles inside the frame: the size the person chose, the theme's colours, and how marks are drawn. */
export function readerCss(look: ChapterAppearance): string {
  const marks = Object.entries(look.marks).flatMap(([color, { fill, line }]) => [
    `::highlight(${MARK_PREFIX}highlight-${color}) { background-color: ${fill}; color: ${look.markInk}; }`,
    `::highlight(${MARK_PREFIX}underline-${color}) { text-decoration: underline 2px ${line}; text-decoration-color: ${line}; }`,
  ]);
  const dark =
    look.scheme === 'dark'
      ? [
          `body, body * { color: ${look.ink} !important; background-color: transparent !important; border-color: currentColor; }`,
          `a, a * { color: ${look.link} !important; }`,
        ]
      : [];
  return [
    `:root { color-scheme: ${look.scheme}; font-size: ${look.fontSize}%; background: ${look.page}; }`,
    `body { margin: 0 auto; padding: 32px 40px 96px; max-width: 42em; line-height: 1.6; color: ${look.ink}; overflow-wrap: break-word; }`,
    'img, svg, video { max-width: 100%; height: auto; }',
    ...dark,
    ...marks,
    `::highlight(${MARK_PREFIX}found) { background-color: ${look.found}; color: ${look.markInk}; }`,
    `::highlight(${MARK_PREFIX}found-current) { background-color: ${look.foundCurrent}; color: ${look.markInk}; }`,
    `::highlight(${MARK_PREFIX}flash) { background-color: ${look.flash}; color: ${look.markInk}; }`,
  ].join('\n');
}
