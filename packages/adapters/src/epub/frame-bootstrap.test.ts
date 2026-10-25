// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  frameBootstrapModule,
  GENERATED,
  sha256Base64,
} from '../../../../tools/epub/frame-bootstrap.ts';
import { FRAME_SHELL } from './chapter-frame.ts';
import { buildChapter, startFrame } from './frame-bootstrap.ts';
import { FRAME_BOOTSTRAP, FRAME_BOOTSTRAP_SHA256 } from './frame-bootstrap.generated.ts';
import type { FrameNode, FromFrame, ToFrame } from './frame-protocol.ts';

/*
 * DFAI's script in a chapter's frame (#505, ADR-0045): the one the frame's
 * policy names by hash, made from its source and run exactly; and what it
 * does there — builds the chapter from the reader's nodes and nothing that
 * could run or load, takes word only from the reader, stops every click,
 * and tells the reader the selection, links, keys and scrolling.
 */

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const MATHML = 'http://www.w3.org/1998/Math/MathML';

/** A chapter of two paragraphs and a link, as the reader hands it: "Hello there" + "\n" + "Go on". */
const CHAPTER: FrameNode[] = [
  [-1, 1, XHTML, 'html', []],
  [0, 1, XHTML, 'body', []],
  [1, 1, XHTML, 'p', ['', 'id', 'first']],
  [2, 3, 'Hello there', 0],
  [1, 1, XHTML, 'p', []],
  [
    4,
    1,
    XHTML,
    'a',
    ['', 'href', '#', '', 'data-dfai-path', 'OEBPS/two.xhtml', '', 'data-dfai-fragment', 'top'],
  ],
  [5, 3, 'Go on', 12],
  [1, 1, MATHML, 'mtext', ['', 'id', 'math']],
  [7, 3, 'x', 17],
];
const LENGTH = 18;

class FakeHighlight {
  priority = 0;
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

/** A frame's window of its own, with what jsdom lacks put in, and what the script tells its reader kept. */
function frameWindow() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const view = dom.window as unknown as Window & typeof globalThis;
  const sent: FromFrame[] = [];
  const highlights = new Map<string, FakeHighlight>();
  Object.assign(view, {
    Highlight: FakeHighlight,
    CSSStyleSheet: class {
      css = '';
      replaceSync(css: string) {
        this.css = css;
      }
    },
    scrollTo: () => undefined,
  });
  Object.defineProperty(view, 'CSS', { value: { highlights, escape: (text: string) => text } });
  const adopted = new WeakMap<Document, unknown>();
  Object.defineProperty(view.Document.prototype, 'adoptedStyleSheets', {
    get(this: Document) {
      return adopted.get(this) ?? [];
    },
    set(this: Document, sheets: unknown) {
      adopted.set(this, sheets);
    },
  });
  view.Range.prototype.getBoundingClientRect = () => new view.DOMRect(5, 6, 7, 8);
  view.postMessage = ((message: FromFrame) => void sent.push(message)) as Window['postMessage'];
  const say = (message: ToFrame | unknown, source: Window | null = view) =>
    view.dispatchEvent(new view.MessageEvent('message', { data: message, source }));
  startFrame(view, view);
  return { view, doc: view.document, sent, say, highlights };
}

function shownWindow() {
  const frame = frameWindow();
  frame.say({ kind: 'chapter', nodes: CHAPTER, length: LENGTH });
  return frame;
}

describe("the frame's script, as the frame runs it", () => {
  it('is what its sources make now', () => {
    expect(readFileSync(GENERATED, 'utf8')).toBe(frameBootstrapModule());
  });

  it("is named in the frame's policy by its own hash, and nothing else may run", () => {
    expect(sha256Base64(FRAME_BOOTSTRAP)).toBe(FRAME_BOOTSTRAP_SHA256);
    const shell = new DOMParser().parseFromString(FRAME_SHELL, 'text/html');
    const [policy, script] = Array.from(shell.head.children);
    expect(policy?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(policy?.getAttribute('content')).toContain(
      `script-src 'sha256-${FRAME_BOOTSTRAP_SHA256}';`,
    );
    expect(script?.localName).toBe('script');
    expect(script?.textContent).toBe(FRAME_BOOTSTRAP);
    expect(shell.body.childNodes).toHaveLength(0);
  });

  it('is one script that parses, and starts itself for the frame', () => {
    expect(() => new Function(FRAME_BOOTSTRAP)).not.toThrow();
    expect(FRAME_BOOTSTRAP.trimEnd().endsWith('startFrame(window, window.parent);\n})();')).toBe(
      true,
    );
    expect(FRAME_BOOTSTRAP).not.toMatch(/^\s*(import|export)\b/m);
  });
});

describe('the frame takes word only from its reader', () => {
  it('says it is ready, and shows the chapter once it is handed it', () => {
    const { doc, sent, say } = frameWindow();
    expect(sent).toEqual([{ kind: 'ready' }]);
    say({ kind: 'chapter', nodes: CHAPTER, length: LENGTH });
    expect(sent.at(-1)).toEqual({ kind: 'shown' });
    expect(doc.body.textContent).toBe('Hello thereGo onx');
  });

  it('ignores a message from any other window, and a second chapter', () => {
    const { doc, sent, say } = frameWindow();
    say({ kind: 'chapter', nodes: CHAPTER, length: LENGTH }, null);
    expect(sent).toEqual([{ kind: 'ready' }]);
    expect(doc.body.textContent).toBe('');
    say({ kind: 'chapter', nodes: CHAPTER, length: LENGTH });
    say({ kind: 'chapter', nodes: [[-1, 1, XHTML, 'html', []]], length: 0 });
    expect(sent.filter((message) => message.kind === 'shown')).toHaveLength(1);
    expect(doc.body.textContent).toBe('Hello thereGo onx');
  });

  it('builds nothing from what is not a chapter', () => {
    for (const [nodes, length] of [
      [[], 0],
      ['<html><script>x</script></html>', 0],
      [[[-1, 3, 'text first', 0]], 10],
      [CHAPTER, -1],
      [CHAPTER, 1.5],
    ] as const) {
      const doc = document.implementation.createHTMLDocument('');
      expect(buildChapter(doc, nodes, length), JSON.stringify(nodes)).toBeNull();
    }
  });
});

describe('the frame builds nothing that runs, loads, or leads out', () => {
  function built(nodes: FrameNode[]) {
    const doc = document.implementation.createHTMLDocument('');
    buildChapter(doc, [[-1, 1, XHTML, 'html', []], [0, 1, XHTML, 'body', []], ...nodes], 0);
    return doc;
  }

  it('builds an empty, hidden element in place of one that runs or embeds', () => {
    const doc = built([
      [1, 1, XHTML, 'script', []],
      [2, 3, 'window.parent.x = 1', -1],
      [1, 1, XHTML, 'iframe', ['', 'src', 'data:text/html,hi']],
      [1, 1, SVG, 'svg:script', []],
      [1, 1, XHTML, 'meta', ['', 'http-equiv', 'refresh']],
      [1, 1, XHTML, 'object', []],
      [1, 1, SVG, 'set', ['', 'attributeName', 'href']],
    ]);
    const names = Array.from(doc.body.children, (element) => element.localName);
    expect(names).toEqual(['span', 'span', 'span', 'span', 'span', 'span']);
    expect(Array.from(doc.body.children).every((element) => element.hasAttribute('hidden'))).toBe(
      true,
    );
    expect(doc.querySelectorAll('script, iframe, meta, object').length).toBe(0);
  });

  it('keeps no handler, no address that is not written in, and no href but a link’s and an SVG loader’s', () => {
    const doc = built([
      [
        1,
        1,
        XHTML,
        'p',
        ['', 'onclick', 'x()', '', 'ONMOUSEOVER', 'x()', '', 'style', 'color: red'],
      ],
      [
        1,
        1,
        XHTML,
        'img',
        ['', 'src', 'https://beacon.example.com/b.png', '', 'srcset', 'a.png 2x'],
      ],
      [1, 1, XHTML, 'img', ['', 'src', 'data:image/png;base64,AAAA']],
      [1, 1, XHTML, 'a', ['', 'href', 'javascript:x()', '', 'target', '_top']],
      [1, 1, XHTML, 'a', ['', 'href', '#']],
      [1, 1, MATHML, 'mtext', ['', 'href', 'data:image/svg+xml,<svg/>']],
      [1, 1, SVG, 'use', ['', 'href', '#shape']],
      [
        1,
        1,
        SVG,
        'image',
        ['http://www.w3.org/1999/xlink', 'xlink:href', 'blob:tauri://localhost/x'],
      ],
      [1, 1, SVG, 'image', ['', 'href', 'data:image/svg+xml;base64,AAAA']],
      [1, 1, XHTML, 'form', ['', 'action', 'https://beacon.example.com/post']],
      [1, 1, XHTML, 'video', ['', 'poster', 'https://beacon.example.com/p.png']],
      [
        1,
        1,
        XHTML,
        'div',
        ['http://www.w3.org/2000/xmlns/', 'xmlns:x', 'urn:x', '', 'bad name', 'x'],
      ],
    ]);
    const kept = Array.from(doc.body.children, (element) =>
      [element.localName, ...Array.from(element.attributes, (a) => `${a.name}=${a.value}`)].join(
        ' ',
      ),
    );
    expect(kept).toEqual([
      'p style=color: red',
      'img',
      'img src=data:image/png;base64,AAAA',
      'a',
      'a href=#',
      'mtext',
      'use href=#shape',
      'image',
      'image href=data:image/svg+xml;base64,AAAA',
      'form',
      'video',
      'div',
    ]);
  });

  it('leaves out a node whose parent is not an element built before it', () => {
    const doc = built([
      [1, 3, 'kept', -1],
      [3, 1, XHTML, 'b', []],
      [99, 1, XHTML, 'i', []],
      [-5, 3, 'nowhere', -1],
    ]);
    expect(doc.body.textContent).toBe('kept');
    expect(doc.getElementsByTagName('b')).toHaveLength(0);
  });
});

describe('the frame tells its reader what the person does', () => {
  it('names the selection as offsets of the chapter’s text, with its box', () => {
    const { doc, view, sent } = shownWindow();
    const selection = view.getSelection();
    const range = doc.createRange();
    range.setStart(doc.querySelector('#first')?.firstChild as Text, 6);
    range.setEnd(doc.querySelector('a')?.firstChild as Text, 2);
    selection?.addRange(range);
    doc.body.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true }));
    expect(sent.at(-1)).toEqual({
      kind: 'selection',
      cause: 'end',
      selection: { start: 6, end: 14, rect: { left: 5, top: 6, width: 7, height: 8 } },
    });
    selection?.removeAllRanges();
    view.dispatchEvent(new view.Event('scroll'));
    expect(sent.at(-1)).toEqual({ kind: 'selection', cause: 'scroll', selection: null });
  });

  it('stops every click, and tells of one on a link of the book by the path the cleaning wrote', () => {
    const { doc, view, sent } = shownWindow();
    const onLink = new view.MouseEvent('click', { bubbles: true, cancelable: true });
    doc.querySelector('a')?.firstChild?.parentElement?.dispatchEvent(onLink);
    expect(onLink.defaultPrevented).toBe(true);
    expect(sent.at(-1)).toEqual({ kind: 'link', path: 'OEBPS/two.xhtml', fragment: 'top' });
    const count = sent.length;
    const onMath = new view.MouseEvent('click', { bubbles: true, cancelable: true });
    doc.querySelector('#math')?.dispatchEvent(onMath);
    expect(onMath.defaultPrevented).toBe(true);
    expect(sent).toHaveLength(count);
  });

  it('tells of each key, and keeps ⌘F for the reader', () => {
    const { doc, view, sent } = shownWindow();
    const find = new view.KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    doc.body.dispatchEvent(find);
    expect(find.defaultPrevented).toBe(true);
    expect(sent.at(-1)).toEqual({
      kind: 'key',
      key: 'f',
      meta: true,
      ctrl: false,
      shift: false,
      alt: false,
    });
    const plain = new view.KeyboardEvent('keydown', { key: 'j', cancelable: true, bubbles: true });
    doc.body.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });
});

describe('the frame draws what the reader asks', () => {
  const paint = (groups: unknown, clear: unknown = ['dfai-highlight-', 'dfai-flash']) => ({
    kind: 'paint',
    clear,
    groups,
  });

  it("draws each group's ranges under its name, and takes away the ones it clears and does not draw", () => {
    const { say, highlights } = shownWindow();
    say(paint([{ name: 'dfai-highlight-yellow', priority: 0, ranges: [0, 5, 12, 14] }]));
    say({
      kind: 'paint',
      clear: ['dfai-found'],
      groups: [{ name: 'dfai-found', priority: 0, ranges: [6, 11] }],
    });
    const yellow = highlights.get('dfai-highlight-yellow');
    expect(yellow?.ranges.map((range) => range.toString())).toEqual(['Hello', 'Go']);
    say(paint([{ name: 'dfai-flash', priority: 1, ranges: [6, 11] }]));
    expect([...highlights.keys()].sort()).toEqual(['dfai-flash', 'dfai-found']);
    expect(highlights.get('dfai-flash')?.priority).toBe(1);
  });

  it('draws nothing of a paint that does not fit: past the text, under a name it does not clear, or not a name', () => {
    const { say, highlights } = shownWindow();
    for (const bad of [
      paint([{ name: 'dfai-highlight-yellow', priority: 0, ranges: [0, LENGTH + 1] }]),
      paint([{ name: 'dfai-found', priority: 0, ranges: [0, 1] }]),
      paint([{ name: 'dfai-highlight-<b>', priority: 0, ranges: [0, 1] }]),
      paint([{ name: 'dfai-highlight-yellow', priority: 2, ranges: [0, 1] }]),
      paint([{ name: 'dfai-highlight-yellow', priority: 0, ranges: ['0', 1] }]),
      paint([], ['not-dfai']),
      paint('everything'),
    ]) {
      say(bad);
    }
    expect(highlights.size).toBe(0);
  });

  it("takes the reader's styles as its own sheet", () => {
    const { say, doc } = shownWindow();
    say({ kind: 'style', css: 'body { color: red; }' });
    const sheets = (doc as unknown as { adoptedStyleSheets: { css: string }[] }).adoptedStyleSheets;
    expect(sheets.map((sheet) => sheet.css)).toEqual(['body { color: red; }']);
    say({ kind: 'style', css: 42 });
    expect(
      (doc as unknown as { adoptedStyleSheets: { css: string }[] }).adoptedStyleSheets,
    ).toHaveLength(1);
  });
});

describe('the frame scrolls where the reader asks', () => {
  it('brings an offset of the text into view, and leaves one past the text alone', () => {
    const { view, say } = shownWindow();
    const scrolled: unknown[] = [];
    view.scrollTo = ((to: unknown) => void scrolled.push(to)) as Window['scrollTo'];
    say({ kind: 'scroll-to-offset', offset: 12 });
    say({ kind: 'scroll-to-offset', offset: LENGTH + 1 });
    say({ kind: 'scroll-to-offset', offset: '12' });
    // The box jsdom is given is at 6 from the top: 80 above it is above the page.
    expect(scrolled).toEqual([{ top: 0 }]);
  });

  it('brings an element the book names into view, or the top for none', () => {
    const { view, doc, say } = shownWindow();
    const scrolled: unknown[] = [];
    view.scrollTo = ((to: unknown) => void scrolled.push(to)) as Window['scrollTo'];
    const into: string[] = [];
    view.Element.prototype.scrollIntoView = function (this: Element) {
      into.push(this.id);
    };
    say({ kind: 'scroll-to-fragment', fragment: 'first' });
    say({ kind: 'scroll-to-fragment', fragment: 'nowhere' });
    say({ kind: 'scroll-to-fragment', fragment: null });
    say({ kind: 'scroll-to-fragment', fragment: 'x'.repeat(3000) });
    expect(into).toEqual(['first']);
    expect(scrolled).toEqual([{ top: 0 }, { top: 0 }]);
    expect(doc.getElementById('first')).not.toBeNull();
  });

  it('lets the selection go when the reader asks', () => {
    const { view, doc, say } = shownWindow();
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    view.getSelection()?.addRange(range);
    say({ kind: 'clear-selection' });
    expect(view.getSelection()?.rangeCount).toBe(0);
  });

  it('draws nothing before it holds a chapter, and nothing for a message that is not one', () => {
    const { say, highlights, sent } = frameWindow();
    say({
      kind: 'paint',
      clear: ['dfai-found'],
      groups: [{ name: 'dfai-found', priority: 0, ranges: [0, 1] }],
    });
    say({ kind: 'scroll-to-offset', offset: 0 });
    say(null);
    say('chapter');
    say({ kind: 'everything' });
    expect(highlights.size).toBe(0);
    expect(sent).toEqual([{ kind: 'ready' }]);
  });
});

describe("a book's names do not stand in for the document's own members (regressions from the attack on PR #536)", () => {
  const SHADOWING: FrameNode[] = [
    [-1, 1, XHTML, 'html', []],
    [0, 1, XHTML, 'body', []],
    [1, 1, XHTML, 'img', ['', 'name', 'createRange', '', 'id', 'getElementById']],
    [1, 1, XHTML, 'img', ['', 'name', 'querySelector']],
    [1, 1, XHTML, 'form', ['', 'name', 'body']],
    [4, 1, XHTML, 'input', ['', 'name', 'appendChild', '', 'id', 'nodeType']],
    [4, 1, XHTML, 'p', ['', 'id', 'title']],
    [6, 3, 'Slow and steady', 0],
    [1, 1, XHTML, 'a', ['', 'name', 'top']],
  ];

  it('builds no name or id that would shadow a member of the document or a form, and keeps every other', () => {
    const { doc, say, sent } = frameWindow();
    say({ kind: 'chapter', nodes: SHADOWING, length: 15 });
    expect(sent.at(-1)).toEqual({ kind: 'shown' });
    const [first, second] = Array.from(doc.querySelectorAll('img'));
    expect([first?.hasAttribute('name'), first?.hasAttribute('id')]).toEqual([false, false]);
    expect(second?.hasAttribute('name')).toBe(false);
    expect(doc.querySelector('form')?.hasAttribute('name')).toBe(false);
    expect(doc.querySelector('input')?.attributes).toHaveLength(0);
    // A paragraph's id and a link's name shadow nothing: they stay places a link can lead to.
    expect(doc.querySelector('p')?.id).toBe('title');
    expect(doc.querySelector('a')?.getAttribute('name')).toBe('top');
    expect(doc.querySelector('p')?.textContent).toBe('Slow and steady');
  });

  it('builds, draws and scrolls through the DOM’s own members, whatever the document’s own properties say', () => {
    const { view, doc, say, sent, highlights } = frameWindow();
    const shadow = (target: object, names: readonly string[]) => {
      for (const name of names) Object.defineProperty(target, name, { value: 'shadowed' });
    };
    // As a named property of the document would: an own property in front of the prototype's.
    shadow(doc, [
      'createTextNode',
      'createElementNS',
      'replaceChild',
      'documentElement',
      'createRange',
      'getElementById',
      'querySelector',
      'adoptedStyleSheets',
    ]);
    say({ kind: 'chapter', nodes: CHAPTER, length: LENGTH });
    expect(sent.at(-1)).toEqual({ kind: 'shown' });
    say({
      kind: 'paint',
      clear: ['dfai-highlight-'],
      groups: [{ name: 'dfai-highlight-green', priority: 0, ranges: [0, 5] }],
    });
    expect(highlights.get('dfai-highlight-green')?.ranges.map(String)).toEqual(['Hello']);
    const into: string[] = [];
    view.Element.prototype.scrollIntoView = function (this: Element) {
      into.push(this.id || (this.getAttribute('name') ?? ''));
    };
    say({ kind: 'scroll-to-fragment', fragment: 'first' });
    expect(into).toEqual(['first']);
  });

  it('builds and follows a link inside a form whose controls shadow its members', () => {
    const { view, doc, say, sent } = frameWindow();
    say({ kind: 'chapter', nodes: CHAPTER, length: LENGTH });
    const link = doc.querySelector('a');
    // As a form's named controls would: own properties in front of the element's prototype.
    for (const name of ['closest', 'getAttribute']) {
      Object.defineProperty(link as Element, name, { value: 'shadowed' });
    }
    link?.firstChild?.parentElement?.dispatchEvent(
      new view.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(sent.at(-1)).toEqual({ kind: 'link', path: 'OEBPS/two.xhtml', fragment: 'top' });
  });
});
