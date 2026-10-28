// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { LanguageFn } from 'lowlight';
import { createCodeLanguages, type CodeGrammar, type CodeLanguages } from './code-languages.ts';
import { createReadingExtensions } from './extensions.ts';

/*
 * Attack on PR #605 (#265): the highlighting is decorations only (ADR-0003),
 * so the document, its undo history and what is handed on to save must be
 * exactly what the edits alone would make, whatever order grammars arrive in.
 */

const GRAMMARS: Record<CodeGrammar, LanguageFn> = {
  bash,
  css,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

/** mulberry32: a small seeded RNG, so a failing run can be replayed by its seed. */
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number) => Math.floor(next() * below);
  const pick = <T>(from: readonly T[]): T => from[int(from.length)] as T;
  return { next, int, pick };
}
type Rng = ReturnType<typeof seeded>;

/** Grammars handed over (or failed) only when the test says. */
function heldGrammars() {
  const waiting = new Map<CodeGrammar, Array<{ give: () => void; fail: () => void }>>();
  const asked: Array<{ grammar: CodeGrammar; fresh: boolean }> = [];
  const languages = createCodeLanguages(
    (grammar, { fresh }) =>
      new Promise<LanguageFn>((resolve, reject) => {
        asked.push({ grammar, fresh });
        const held = waiting.get(grammar) ?? [];
        held.push({
          give: () => resolve(GRAMMARS[grammar]),
          fail: () => reject(new Error('Importing a module script failed.')),
        });
        waiting.set(grammar, held);
      }),
  );
  const flush = () => new Promise((done) => setTimeout(done, 0));
  const settle = async (grammar: CodeGrammar, how: 'give' | 'fail') => {
    const held = waiting.get(grammar)?.shift();
    if (held === undefined) throw new Error(`${grammar} was not asked for`);
    if (waiting.get(grammar)?.length === 0) waiting.delete(grammar);
    held[how]();
    await flush();
  };
  const pendingGrammars = () => [...waiting.keys()];
  return { languages, asked, settle, pendingGrammars, flush };
}

const code = (language: string | null, text: string): JSONContent => ({
  type: 'codeBlock',
  attrs: { language },
  ...(text === '' ? {} : { content: [{ type: 'text', text }] }),
});
const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  ...(text === '' ? {} : { content: [{ type: 'text', text }] }),
});

const editors: Editor[] = [];
function editorOf(content: JSONContent[], languages: CodeLanguages | null): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createReadingExtensions({ loadImage: async () => null, codeLanguages: languages }),
    content: { type: 'doc', content },
  });
  editors.push(editor);
  return editor;
}

let now = Date.UTC(2026, 0, 1);
beforeEach(() => {
  // History groups edits by `Date.now()`; a fixed clock, stepped by the test, makes it deterministic.
  vi.useFakeTimers({ toFake: ['Date'] });
  now = Date.UTC(2026, 0, 1);
  vi.setSystemTime(now);
});
afterEach(() => {
  for (const editor of editors.splice(0)) if (!editor.isDestroyed) editor.destroy();
  vi.useRealTimers();
});
const tick = (ms = 1000) => {
  now += ms;
  vi.setSystemTime(now);
};

/** Each code block's drawn text and the classes drawn over it. */
const drawn = (editor: Editor) =>
  [...editor.view.dom.querySelectorAll('pre code')].map((block) => ({
    text: block.textContent,
    classes: [...block.querySelectorAll('[class*="hljs-"]')].map((span) => span.className),
  }));

const codeTexts = (editor: Editor): string[] => {
  const texts: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'codeBlock') texts.push(node.textContent);
    return !node.isTextblock;
  });
  return texts;
};

const LANGUAGES: readonly (string | null)[] = [
  'bash',
  'sh',
  'zsh',
  'css',
  'json',
  'jsonc',
  'markdown',
  'md',
  'python',
  'py',
  'rust',
  'rs',
  'sql',
  'typescript',
  'ts',
  'js',
  'JS',
  'TSX',
  'xml',
  'html',
  'yaml',
  'yml',
  ' Py ',
  'cobol',
  '',
  null,
];

const SNIPPETS: readonly string[] = [
  'const kale = 55;',
  'def lantern(rows):\n    return 42',
  'SELECT * FROM barn WHERE hens > 3;',
  '<a href="x">hay</a>',
  'key: value\nlist:\n  - one',
  '# Heading\n\n```js\nnested();\n```',
  '````\n```ts\nlet inner = 1;\n```\n````',
  'fn main() { println!("ünïcødé 🌱"); }',
  '{"a": [1, 2, {"b": null}]}',
  'echo "$HOME" | grep -v x',
  '.barn > .hen { color: red; }',
  '\t\n',
  '',
];

function randomNote(rng: Rng): JSONContent[] {
  const blocks: JSONContent[] = [];
  const count = 1 + rng.int(5);
  for (let at = 0; at < count; at += 1) {
    if (rng.next() < 0.3) blocks.push(paragraph(rng.pick(['Prose.', 'The hens.', ''])));
    else {
      const long = rng.next() < 0.08;
      const text = long
        ? Array.from({ length: 400 }, (_, line) => `let row${line} = "${line}";`).join('\n')
        : rng.pick(SNIPPETS);
      blocks.push(code(rng.pick(LANGUAGES), text));
    }
  }
  return blocks;
}

/** A random place inside a random textblock of `doc`: [from, to] within the block. */
function placeIn(editor: Editor, rng: Rng): { from: number; to: number; code: boolean } | null {
  const places: Array<{ start: number; size: number; code: boolean }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      places.push({
        start: pos + 1,
        size: node.content.size,
        code: node.type.name === 'codeBlock',
      });
      return false;
    }
    return true;
  });
  if (places.length === 0) return null;
  const place = rng.pick(places);
  const a = place.start + rng.int(place.size + 1);
  const b = place.start + rng.int(place.size + 1);
  return { from: Math.min(a, b), to: Math.max(a, b), code: place.code };
}

type Step =
  | { kind: 'type'; at: number; text: string }
  | { kind: 'delete'; from: number; to: number }
  | { kind: 'language'; pos: number; language: string | null }
  | { kind: 'undo' }
  | { kind: 'redo' };

function applyStep(editor: Editor, step: Step) {
  switch (step.kind) {
    case 'type':
      editor.view.dispatch(editor.state.tr.insertText(step.text, step.at));
      return;
    case 'delete':
      editor.view.dispatch(editor.state.tr.delete(step.from, step.to));
      return;
    case 'language':
      editor.view.dispatch(editor.state.tr.setNodeAttribute(step.pos, 'language', step.language));
      return;
    case 'undo':
      editor.commands.undo();
      return;
    case 'redo':
      editor.commands.redo();
  }
}

function randomStep(editor: Editor, rng: Rng): Step | null {
  const roll = rng.next();
  if (roll < 0.15) return { kind: 'undo' };
  if (roll < 0.22) return { kind: 'redo' };
  if (roll < 0.32) {
    const blocks: number[] = [];
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'codeBlock') blocks.push(offset);
    });
    if (blocks.length === 0) return null;
    return { kind: 'language', pos: rng.pick(blocks), language: rng.pick(LANGUAGES) };
  }
  const place = placeIn(editor, rng);
  if (place === null) return null;
  if (roll < 0.5 && place.to > place.from)
    return { kind: 'delete', from: place.from, to: place.to };
  return { kind: 'type', at: place.from, text: rng.pick(['x', ' = 1;', '```', '\n', 'é', '"']) };
}

describe('#265 attack: highlighting never changes the file, the history or what is saved', () => {
  it.each(Array.from({ length: 40 }, (_, seed) => [seed + 1]))(
    'seed %i: the edited note equals the same edits with no highlighting, and every redraw is invisible',
    async (seed) => {
      const rng = seeded(seed);
      const note = randomNote(rng);
      const held = heldGrammars();
      const subject = editorOf(note, held.languages);
      const reference = editorOf(note, null);
      // A selection that changes nothing, as a focus would: both get their trailing line
      // now, so the trailing-line finding (tested on its own below) does not mask the rest.
      for (const editor of [subject, reference]) editor.view.dispatch(editor.state.tr);
      let subjectUpdates = 0;
      let referenceUpdates = 0;
      subject.on('update', () => (subjectUpdates += 1));
      reference.on('update', () => (referenceUpdates += 1));

      for (let step = 0; step < 40; step += 1) {
        tick();
        const pending = held.pendingGrammars();
        if (pending.length > 0 && rng.next() < 0.35) {
          await held.settle(rng.pick(pending), rng.next() < 0.25 ? 'fail' : 'give');
        } else {
          const next = randomStep(reference, rng);
          if (next === null) continue;
          applyStep(subject, next);
          applyStep(reference, next);
        }
        const context = `seed ${seed}, step ${step}`;
        expect(subject.getJSON(), context).toEqual(reference.getJSON());
        expect(undoDepth(subject.state), context).toBe(undoDepth(reference.state));
        expect(subjectUpdates, context).toBe(referenceUpdates);
        // The drawn text is the code's own text, coloured or not.
        expect(
          drawn(subject).map((block) => block.text),
          context,
        ).toEqual(codeTexts(subject));
      }

      // Every grammar asked for arrives: the note is drawn as a freshly opened one would be.
      for (let round = 0; round < 5 && held.pendingGrammars().length > 0; round += 1) {
        for (const grammar of held.pendingGrammars()) await held.settle(grammar, 'give');
      }
      const fresh = editorOf(subject.getJSON().content ?? [], held.languages);
      for (const grammar of held.pendingGrammars()) await held.settle(grammar, 'give');
      expect(drawn(subject), `seed ${seed}: colours match a fresh open`).toEqual(drawn(fresh));
      expect(subject.getJSON()).toEqual(reference.getJSON());
      expect(subjectUpdates).toBe(referenceUpdates);
    },
  );
});

/** The loader, counting who listens for arrivals and every character it highlights. */
function counted(languages: CodeLanguages) {
  let listening = 0;
  let highlighted = 0;
  const wrapped: CodeLanguages = {
    highlight: (grammar, text) => {
      const tree = languages.highlight(grammar, text);
      if (tree !== null) highlighted += text.length;
      return tree;
    },
    load: (grammar) => languages.load(grammar),
    onReady: (listener) => {
      listening += 1;
      const stop = languages.onReady(listener);
      let stopped = false;
      return () => {
        if (!stopped) listening -= 1;
        stopped = true;
        stop();
      };
    },
  };
  return {
    languages: wrapped,
    listening: () => listening,
    highlighted: () => highlighted,
    resetHighlighted: () => (highlighted = 0),
  };
}

const lastCodeEnd = (editor: Editor): number => {
  let end = -1;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'codeBlock') end = offset + node.nodeSize - 1;
  });
  return end;
};

describe('#265 attack: a grammar arriving is not an edit', () => {
  it('adds nothing to a note that ends in a code block when its grammar arrives', async () => {
    const held = heldGrammars();
    const editor = editorOf([paragraph('Prose.'), code('ts', 'const kale = 55;')], held.languages);
    const opened = editor.getJSON();

    await held.settle('typescript', 'give');

    expect(drawn(editor)[0]?.classes).toContain('hljs-keyword');
    // The redraw's transaction must not set off the trailing line (or any appended edit).
    expect(editor.getJSON()).toEqual(opened);
  });
});

describe('#265 attack: races', () => {
  it('a grammar arriving after the editor is destroyed draws nothing and throws nothing', async () => {
    const held = heldGrammars();
    const count = counted(held.languages);
    const editor = editorOf([code('py', 'def a(): pass')], count.languages);
    editor.destroy();
    expect(count.listening()).toBe(0);

    await expect(held.settle('python', 'give')).resolves.toBeUndefined();
    expect(await held.languages.load('python')).toBe(true);
  });

  it('leaves no arrival listener behind after 50 editors open and close, whatever their grammars did', async () => {
    const held = heldGrammars();
    const count = counted(held.languages);
    const languages: readonly string[] = ['ts', 'py', 'sql', 'yaml', 'cobol'];
    for (let at = 0; at < 50; at += 1) {
      const editor = editorOf(
        [code(languages[at % languages.length] ?? null, 'x')],
        count.languages,
      );
      if (at % 7 === 0) {
        for (const grammar of held.pendingGrammars())
          await held.settle(grammar, at % 2 === 0 ? 'fail' : 'give');
      }
      editor.destroy();
    }
    expect(count.listening()).toBe(0);
  });

  it('two editors on one note are both coloured, and an edit in one leaves the other as it was', async () => {
    const held = heldGrammars();
    const note = [code('sql', 'SELECT 1;')];
    const one = editorOf(note, held.languages);
    const other = editorOf(note, held.languages);
    one.view.dispatch(one.state.tr.insertText(' -- hens', lastCodeEnd(one)));

    await held.settle('sql', 'give');

    expect(drawn(one)[0]?.text).toBe('SELECT 1; -- hens');
    expect(drawn(other)[0]?.text).toBe('SELECT 1;');
    for (const editor of [one, other]) expect(drawn(editor)[0]?.classes).toContain('hljs-keyword');
  });

  it('a note switched away from mid-load is not redrawn, and the note switched to is coloured on its own arrival', async () => {
    const held = heldGrammars();
    const editor = editorOf([code('ts', 'let a = 1;')], held.languages);
    const transactions: number[] = [];
    editor.on('transaction', () => transactions.push(1));
    editor
      .chain()
      .setMeta('addToHistory', false)
      .setContent({ type: 'doc', content: [code('py', 'def a(): pass')] }, { emitUpdate: false })
      .run();
    transactions.length = 0;

    await held.settle('typescript', 'give');
    expect(transactions).toEqual([]);
    expect(drawn(editor)).toEqual([{ text: 'def a(): pass', classes: [] }]);

    await held.settle('python', 'give');
    expect(drawn(editor)[0]?.classes).toContain('hljs-keyword');

    editor.commands.setContent(
      { type: 'doc', content: [code('ts', 'let b = 2;')] },
      { emitUpdate: false },
    );
    expect(drawn(editor)[0]?.classes).toContain('hljs-keyword');
  });

  it('a grammar that failed is asked for again, fresh, when the same editor shows a new block in it', async () => {
    const held = heldGrammars();
    const editor = editorOf([code('ts', 'let a = 1;')], held.languages);
    await held.settle('typescript', 'fail');

    // Still in this editor, the person adds another TypeScript block: the loader says the next ask retries.
    editor.commands.insertContentAt(editor.state.doc.content.size, code('js', 'let b = 2;'));

    expect(held.asked).toEqual([
      { grammar: 'typescript', fresh: false },
      { grammar: 'typescript', fresh: true },
    ]);
    await held.settle('typescript', 'give');
    for (const block of drawn(editor)) expect(block.classes).toContain('hljs-keyword');
  });

  it('typing at 60 keys a second through a load loses no key, hands on every key, and undoes as the same typing would', async () => {
    const held = heldGrammars();
    const subject = editorOf([code('rs', 'fn main() {}')], held.languages);
    const reference = editorOf([code('rs', 'fn main() {}')], null);
    for (const editor of [subject, reference]) editor.view.dispatch(editor.state.tr);
    let updates = 0;
    subject.on('update', () => (updates += 1));
    const typed = 'let barn = "hay"; '.repeat(7);
    for (let key = 0; key < typed.length; key += 1) {
      tick(16);
      if (key === 50) await held.settle('rust', 'give');
      for (const editor of [subject, reference]) {
        editor.view.dispatch(editor.state.tr.insertText(typed[key] ?? '', lastCodeEnd(editor)));
      }
    }
    expect(codeTexts(subject)).toEqual([`fn main() {}${typed}`]);
    expect(updates).toBe(typed.length);
    expect(undoDepth(subject.state)).toBe(undoDepth(reference.state));
    expect(drawn(subject)[0]?.classes).toContain('hljs-string');
    tick();
    subject.commands.undo();
    reference.commands.undo();
    expect(subject.getJSON()).toEqual(reference.getJSON());
  });

  it('keeps an IME composition in a code block alive when its grammar arrives', async () => {
    const held = heldGrammars();
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: createReadingExtensions({
        loadImage: async () => null,
        codeLanguages: held.languages,
      }),
      content: { type: 'doc', content: [code('ts', 'const kale = ')] },
    });
    editors.push(editor);
    const end = lastCodeEnd(editor);
    editor.commands.setTextSelection(end);
    const textNode = editor.view.dom.querySelector('pre code')?.firstChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
    const selection = document.getSelection();
    selection?.collapse(textNode ?? null, textNode?.textContent?.length ?? 0);
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(editor.view.composing).toBe(true);

    await held.settle('typescript', 'give');

    expect(editor.view.composing).toBe(true);
    // The text node the input method is writing into is still the one on screen.
    expect(textNode?.isConnected).toBe(true);
    host.remove();
  });
});

describe('#265 attack: the loader', () => {
  it('tells every listener a grammar arrived even when one of them throws, and the load still resolves', async () => {
    const languages = createCodeLanguages(async () => typescript);
    const told: string[] = [];
    languages.onReady(() => {
      throw new Error('a listener that breaks');
    });
    languages.onReady((grammar) => told.push(grammar));

    await expect(languages.load('typescript')).resolves.toBe(true);
    expect(told).toEqual(['typescript']);
  });

  it('answers false, not a throw, when the fetch throws before it returns a promise', async () => {
    const languages = createCodeLanguages(() => {
      throw new Error('No chunk for the yaml grammar');
    });
    await expect(Promise.resolve().then(() => languages.load('yaml'))).resolves.toBe(false);
  });
});

describe('#265 attack: a very long code block', () => {
  const block = (lines: number) =>
    Array.from({ length: lines }, (_, line) => `const row${line} = "${line}"; // hay`).join('\n');

  /** Characters highlighted, and milliseconds taken, for each of `keys` keystrokes in the block. */
  async function typeInto(lines: number, keys: number, others = 0) {
    const held = heldGrammars();
    const count = counted(held.languages);
    const extra = Array.from({ length: others }, () => code('ts', block(100)));
    const editor = editorOf([...extra, code('ts', block(lines))], count.languages);
    await held.settle('typescript', 'give');
    count.resetHighlighted();
    vi.useRealTimers();
    const started = performance.now();
    for (let key = 0; key < keys; key += 1) {
      editor.view.dispatch(editor.state.tr.insertText('x', lastCodeEnd(editor)));
    }
    const perKey = (performance.now() - started) / keys;
    const codeSize = codeTexts(editor).reduce((sum, text) => sum + text.length, 0);
    return { perKeyChars: count.highlighted() / keys, perKey, codeSize };
  }

  it('re-highlights a typed-in block once per keystroke: linear in its size, never more', async () => {
    const small = await typeInto(2_500, 10);
    const large = await typeInto(10_000, 10);
    // Each keystroke highlights the note's code once: no more than its size (plus the keys typed).
    expect(large.perKeyChars).toBeLessThanOrEqual(large.codeSize);
    expect(small.perKeyChars).toBeLessThanOrEqual(small.codeSize);
    // Four times the code, about four times the time: not quadratic (16x). Generous for jsdom noise.
    expect(large.perKey / small.perKey).toBeLessThan(8);
  });
});

describe('#265 attack: the schema swap', () => {
  beforeEach(() => {
    // jsdom has no ClipboardEvent; ProseMirror's pasteHTML only makes one to hand to handlers.
    if (!('ClipboardEvent' in globalThis)) {
      vi.stubGlobal(
        'ClipboardEvent',
        class extends Event {
          readonly clipboardData = null;
        },
      );
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['<pre><code class="language-js">const a = 1;</code></pre>', 'js'],
    ['<pre><code class="language-JS">const a = 1;</code></pre>', 'JS'],
    ['<pre><code>plain</code></pre>', null],
  ])('a pasted %s keeps its language', async (html, language) => {
    const held = heldGrammars();
    const editor = editorOf([paragraph('')], held.languages);
    editor.commands.setTextSelection(1);
    editor.view.pasteHTML(html);
    const pasted = editor.getJSON().content?.find((node) => node.type === 'codeBlock');
    expect(pasted?.attrs?.['language']).toBe(language);
    if (language !== null) {
      await held.settle('typescript', 'give');
      expect(drawn(editor)[0]?.classes).toContain('hljs-keyword');
    }
  });
});
