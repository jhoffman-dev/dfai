// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EPUB_FRAME_SANDBOX } from '@dfai/domain';
import {
  foundPaint,
  markPaint,
  readerCss,
  showChapter,
  shownChapter,
  type ChapterAppearance,
  type FrameLink,
} from './chapter-frame.ts';
import type { FromFrame, ToFrame } from './frame-protocol.ts';

/*
 * The reader's side of a chapter's frame (#505, ADR-0045): what it asks the
 * frame to draw, kept to the chapter's text; and a frame whose script never
 * starts is said to have failed, and taken away.
 */

const LOOK: ChapterAppearance = {
  fontSize: 120,
  scheme: 'dark',
  ink: '#eee',
  page: '#111',
  link: '#99f',
  marks: {
    yellow: { fill: '#ff0', line: '#aa0' },
    green: { fill: '#0f0', line: '#0a0' },
    blue: { fill: '#00f', line: '#00a' },
    pink: { fill: '#f0f', line: '#a0a' },
    orange: { fill: '#f80', line: '#a50' },
    purple: { fill: '#80f', line: '#50a' },
  } as ChapterAppearance['marks'],
  markInk: '#000',
  flash: '#f00',
  found: '#fc8',
  foundCurrent: '#f84',
};

describe('what the reader asks the frame to draw', () => {
  it("groups the chapter's highlights by style, the lit one again over them", () => {
    const paint = markPaint({
      marks: [
        { id: 'a', start: 0, end: 5, style: { mark: 'highlight', color: 'yellow' } },
        { id: 'b', start: 8, end: 9, style: { mark: 'highlight', color: 'yellow' } },
        { id: 'c', start: 2, end: 4, style: { mark: 'underline', color: 'green' } },
      ],
      flashing: 'c',
      length: 10,
    });
    expect(paint).toEqual({
      kind: 'paint',
      clear: ['dfai-highlight-', 'dfai-underline-', 'dfai-flash'],
      groups: [
        { name: 'dfai-highlight-yellow', priority: 0, ranges: [0, 5, 8, 9] },
        { name: 'dfai-underline-green', priority: 0, ranges: [2, 4] },
        { name: 'dfai-flash', priority: 1, ranges: [2, 4] },
      ],
    });
  });

  it('leaves out a stretch the chapter does not have, so the frame draws the rest', () => {
    const style = { mark: 'highlight', color: 'blue' } as const;
    const paint = markPaint({
      marks: [
        { id: 'past', start: 8, end: 12, style },
        { id: 'back', start: 5, end: 2, style },
        { id: 'ok', start: 1, end: 2, style },
      ],
      flashing: null,
      length: 10,
    });
    expect(paint.kind === 'paint' && paint.groups).toEqual([
      { name: 'dfai-highlight-blue', priority: 0, ranges: [1, 2] },
    ]);
  });

  it("draws find's matches, the current one apart and over the rest", () => {
    expect(
      foundPaint({
        found: [
          { start: 0, end: 2 },
          { start: 4, end: 6 },
          { start: 30, end: 31 },
        ],
        current: 1,
        length: 10,
      }),
    ).toEqual({
      kind: 'paint',
      clear: ['dfai-found'],
      groups: [
        { name: 'dfai-found', priority: 0, ranges: [0, 2] },
        { name: 'dfai-found-current', priority: 1, ranges: [4, 6] },
      ],
    });
  });

  it("styles each mark by its colour, the size chosen, and a dark page's own colours", () => {
    const css = readerCss(LOOK);
    expect(css).toContain('font-size: 120%');
    expect(css).toContain('::highlight(dfai-highlight-yellow) { background-color: #ff0;');
    expect(css).toContain(
      '::highlight(dfai-underline-green) { text-decoration: underline 2px #0a0;',
    );
    expect(css).toContain('color: #eee !important');
    expect(readerCss({ ...LOOK, scheme: 'light' })).not.toContain('!important');
  });
});

describe('a frame whose script never starts', () => {
  it('is said to have failed once it loads, and is taken away', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shown = showChapter({
      host,
      chapter: { nodes: [[-1, 1, 'http://www.w3.org/1999/xhtml', 'html', []]], length: 0 },
      appearance: LOOK,
      events: { onLink() {}, onSelectionEnd() {}, onKeyDown() {}, onScroll() {} },
    });
    const frame = host.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe(EPUB_FRAME_SANDBOX);
    expect(frame?.srcdoc).toContain("script-src 'sha256-");
    await expect(shown).rejects.toThrow('its frame did not start');
    expect(host.querySelector('iframe')).toBeNull();
  });
});

describe('a chapter on screen, as the reader sees it', () => {
  function shown() {
    const host = document.createElement('div');
    document.body.append(host);
    const frame = document.createElement('iframe');
    host.append(frame);
    frame.getBoundingClientRect = () => new DOMRect(100, 50, 600, 400);
    const posted: ToFrame[] = [];
    let hear: (message: FromFrame) => void = () => undefined;
    let closed = false;
    const link: FrameLink = {
      post: (message) => void posted.push(message),
      next: async () => undefined,
      listen: (handler) => {
        hear = handler;
      },
      close: () => {
        closed = true;
      },
    };
    const heard: string[] = [];
    const keys: KeyboardEvent[] = [];
    const chapter = shownChapter({
      frame,
      link,
      length: 50,
      events: {
        onLink: ({ path, fragment }) => heard.push(`link ${path}#${fragment}`),
        onSelectionEnd: () => heard.push('selection end'),
        onKeyDown: (event) => void keys.push(event),
        onScroll: () => heard.push('scroll'),
      },
    });
    return {
      chapter,
      posted,
      hear: (message: FromFrame) => hear(message),
      heard,
      keys,
      host,
      closed: () => closed,
    };
  }

  it("takes the frame's selection as offsets, and its box on the reader's page", () => {
    const { chapter, hear, heard } = shown();
    expect(chapter.selection()).toBeNull();
    hear({
      kind: 'selection',
      cause: 'end',
      selection: { start: 3, end: 9, rect: { left: 10, top: 20, width: 30, height: 12 } },
    });
    expect(heard).toEqual(['selection end']);
    const selected = chapter.selection();
    expect([selected?.start, selected?.end]).toEqual([3, 9]);
    expect([selected?.rect.left, selected?.rect.top, selected?.rect.width]).toEqual([110, 70, 30]);
    hear({ kind: 'selection', cause: 'scroll', selection: null });
    expect(heard).toEqual(['selection end', 'scroll']);
    expect(chapter.selection()).toBeNull();
  });

  it("follows a link of the book, and hands a key to the reader's shortcuts", () => {
    const { hear, heard, keys } = shown();
    hear({ kind: 'link', path: 'OEBPS/two.xhtml', fragment: 'top' });
    hear({ kind: 'key', key: 'f', meta: true, ctrl: false, shift: true, alt: false });
    hear({ kind: 'shown' });
    expect(heard).toEqual(['link OEBPS/two.xhtml#top']);
    expect(
      keys.map((key) => [key.key, key.metaKey, key.ctrlKey, key.shiftKey, key.altKey]),
    ).toEqual([['f', true, false, true, false]]);
  });

  it('asks the frame to draw, scroll, restyle and let the selection go', () => {
    const { chapter, posted, hear } = shown();
    hear({
      kind: 'selection',
      cause: 'end',
      selection: { start: 1, end: 2, rect: { left: 0, top: 0, width: 1, height: 1 } },
    });
    chapter.clearSelection();
    expect(chapter.selection()).toBeNull();
    chapter.paint(
      [{ id: 'a', start: 0, end: 4, style: { mark: 'underline', color: 'pink' } }],
      null,
    );
    chapter.paintFound([{ start: 5, end: 7 }], 0);
    chapter.scrollToOffset(12);
    chapter.scrollToFragment('top');
    chapter.setAppearance(LOOK);
    expect(posted.map((message) => message.kind)).toEqual([
      'clear-selection',
      'paint',
      'paint',
      'scroll-to-offset',
      'scroll-to-fragment',
      'style',
    ]);
    expect(posted[3]).toEqual({ kind: 'scroll-to-offset', offset: 12 });
  });

  it('takes the frame away, and stops listening to it', () => {
    const { chapter, host, closed } = shown();
    chapter.destroy();
    expect(host.querySelector('iframe')).toBeNull();
    expect(closed()).toBe(true);
  });
});
