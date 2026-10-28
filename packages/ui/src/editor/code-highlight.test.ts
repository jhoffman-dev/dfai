// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import bash from 'highlight.js/lib/languages/bash';
import typescript from 'highlight.js/lib/languages/typescript';
import type { LanguageFn } from 'lowlight';
import { createCodeLanguages, type CodeGrammar, type CodeLanguages } from './code-languages.ts';
import { createReadingExtensions } from './extensions.ts';

/** #265: a code block is its plain text until its grammar arrives, then coloured where it stands. */

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

const GRAMMARS: Partial<Record<CodeGrammar, LanguageFn>> = { bash, typescript };

/** Grammars handed over only when the test says, each fetch counted. */
function heldGrammars() {
  const waiting = new Map<CodeGrammar, { give: () => void; fail: () => void }>();
  const asked: CodeGrammar[] = [];
  const languages = createCodeLanguages(
    (grammar) =>
      new Promise<LanguageFn>((resolve, reject) => {
        asked.push(grammar);
        waiting.set(grammar, {
          give: () => resolve(GRAMMARS[grammar] as LanguageFn),
          fail: () => reject(new Error('Importing a module script failed.')),
        });
      }),
  );
  /** Hands over (or fails) the grammar's fetch, then lets the editor take it in. */
  const settle = async (grammar: CodeGrammar, how: 'give' | 'fail') => {
    const held = waiting.get(grammar);
    if (held === undefined) throw new Error(`${grammar} was not asked for`);
    waiting.delete(grammar);
    held[how]();
    await new Promise((done) => setTimeout(done, 0));
  };
  return { languages, asked, settle };
}

const code = (language: string | null, text: string): JSONContent => ({
  type: 'codeBlock',
  attrs: { language },
  content: [{ type: 'text', text }],
});
const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

function reading(content: JSONContent[], languages: CodeLanguages | null): Editor {
  const editor = new Editor({
    extensions: createReadingExtensions({ loadImage: async () => null, codeLanguages: languages }),
    content: { type: 'doc', content },
  });
  editors.push(editor);
  return editor;
}

/** The highlight classes drawn in each code block, in order. */
const drawnClasses = (editor: Editor): string[][] =>
  [...editor.view.dom.querySelectorAll('pre code')].map((block) =>
    [...block.querySelectorAll('[class*="hljs-"]')].map((span) => span.className),
  );

describe('code blocks highlighted on first use', () => {
  it('draws a block as its plain text first, then coloured once its grammar arrives', async () => {
    const { languages, asked, settle } = heldGrammars();
    const editor = reading([code('ts', 'const kale = 55;')], languages);
    const before = editor.getJSON().content?.[0];
    const updates: unknown[] = [];
    editor.on('update', () => updates.push(editor.getJSON()));

    expect(drawnClasses(editor)).toEqual([[]]);
    expect(editor.view.dom.querySelector('pre code')?.textContent).toBe('const kale = 55;');
    expect(asked).toEqual(['typescript']);

    await settle('typescript', 'give');
    expect(drawnClasses(editor)[0]).toEqual(
      expect.arrayContaining(['hljs-keyword', 'hljs-number']),
    );
    expect(editor.view.dom.querySelector('pre code')?.textContent).toBe('const kale = 55;');
    // Decorations only: the block is as it was, and nothing is handed on to save (ADR-0003).
    expect(editor.getJSON().content?.[0]).toEqual(before);
    expect(updates).toEqual([]);
  });

  it('fetches a grammar once for every block and editor that names it, by any of its names', async () => {
    const { languages, asked, settle } = heldGrammars();
    const one = reading([code('js', 'let a = 1;'), code('typescript', 'let b = 2;')], languages);
    const other = reading([code('javascript', 'let c = 3;')], languages);
    expect(asked).toEqual(['typescript']);

    await settle('typescript', 'give');
    for (const editor of [one, other]) {
      for (const classes of drawnClasses(editor)) expect(classes).toContain('hljs-keyword');
    }
  });

  it('asks only for the languages the note shows, and leaves the rest plain', async () => {
    const { languages, asked } = heldGrammars();
    const editor = reading(
      [
        code(null, 'no language'),
        code('cobol', 'DISPLAY "HI".'),
        paragraph('Prose.'),
        code('sh', 'ls'),
      ],
      languages,
    );
    expect(asked).toEqual(['bash']);
    expect(drawnClasses(editor)).toEqual([[], [], []]);
  });

  it('is plain everywhere when the app gives no grammars', () => {
    const editor = reading([code('ts', 'const kale = 55;')], null);
    expect(drawnClasses(editor)).toEqual([[]]);
  });

  it('stays plain when the grammar fails to load, and the next editor to show it loads it afresh', async () => {
    const { languages, asked, settle } = heldGrammars();
    const first = reading([code('ts', 'const kale = 55;')], languages);
    await settle('typescript', 'fail');
    expect(drawnClasses(first)).toEqual([[]]);

    const again = reading([code('ts', 'const kale = 55;')], languages);
    expect(asked).toEqual(['typescript', 'typescript']);
    await settle('typescript', 'give');
    expect(drawnClasses(again)[0]).toContain('hljs-keyword');
  });

  it('colours a note whose grammar failed once another editor loads it, without an edit', async () => {
    const { languages, settle } = heldGrammars();
    const failed = reading([code('ts', 'const kale = 55;')], languages);
    await settle('typescript', 'fail');
    expect(drawnClasses(failed)).toEqual([[]]);

    reading([code('js', 'let a = 1;')], languages);
    await settle('typescript', 'give');
    expect(drawnClasses(failed)[0]).toContain('hljs-keyword');
  });

  it('colours a block typed into, and keeps the colours of a block not touched', async () => {
    const { languages, settle } = heldGrammars();
    const editor = reading([paragraph('Prose.'), code('ts', 'let a = 1;')], languages);
    await settle('typescript', 'give');
    const coloured = drawnClasses(editor);

    editor.commands.insertContentAt(1, 'More ');
    expect(drawnClasses(editor)).toEqual(coloured);

    let end = 0;
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'codeBlock') end = offset + node.nodeSize - 1;
    });
    editor.commands.insertContentAt(end, ' const b = "s";');
    expect(drawnClasses(editor)[0]).toEqual(
      expect.arrayContaining(['hljs-keyword', 'hljs-string']),
    );
  });

  it('asks for a grammar when a block is given a language after the note opened', async () => {
    const { languages, asked } = heldGrammars();
    const editor = reading([code(null, 'echo hi')], languages);
    expect(asked).toEqual([]);
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(0, 'language', 'bash');
      return true;
    });
    expect(asked).toEqual(['bash']);
  });
});
