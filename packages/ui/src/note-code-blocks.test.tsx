// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import python from 'highlight.js/lib/languages/python';
import type { LanguageFn } from 'lowlight';
import type { EditorDocument } from '@dfai/domain';
import { CodeLanguagesProvider } from './editor/code-languages-context.ts';
import { createCodeLanguages, type CodeLanguages } from './editor/code-languages.ts';
import { NoteEditor } from './note-editor.tsx';
import { NoteReading } from './note-reading.tsx';

/** #265: where a note is edited or read, its code is plain until the grammar arrives, then coloured. */

/** What the editor handed on to save; the colours arriving must hand on nothing. */
const changes: EditorDocument[] = [];
afterEach(() => {
  cleanup();
  changes.length = 0;
});

beforeAll(() => {
  const empty = () => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = empty;
  Element.prototype.scrollIntoView = () => {};
});

const CODE = 'def lantern(rows):\n    return 42';
const NOTE: EditorDocument = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The lantern count.' }] },
    { type: 'codeBlock', attrs: { language: 'py' }, content: [{ type: 'text', text: CODE }] },
  ],
} as EditorDocument;

/** The python grammar, handed over when the test says. */
function heldPython(): { languages: CodeLanguages; give: () => Promise<void> } {
  let give: (language: LanguageFn) => void = () => {};
  const arrived = new Promise<LanguageFn>((resolve) => {
    give = resolve;
  });
  return {
    languages: createCodeLanguages(() => arrived),
    give: () =>
      act(async () => {
        give(python);
        await arrived;
      }),
  };
}

const codeBlock = () => document.querySelector('pre code');
const colours = () => [...(codeBlock()?.querySelectorAll('[class*="hljs-"]') ?? [])];

describe.each([
  [
    'read',
    () => (
      <NoteReading
        doc={NOTE}
        label="Body of Lanterns"
        onFollowLink={() => {}}
        loadImage={async () => null}
      />
    ),
  ],
  [
    'edited',
    () => (
      <NoteEditor
        doc={NOTE}
        onChange={(next) => changes.push(next)}
        onFollowLink={() => {}}
        suggestNotes={() => []}
        loadImage={async () => null}
      />
    ),
  ],
])('a code block in a note being %s', (_, note) => {
  it('is its plain text at once, and coloured once its grammar arrives', async () => {
    const { languages, give } = heldPython();
    render(<CodeLanguagesProvider value={languages}>{note()}</CodeLanguagesProvider>);

    await waitFor(() => expect(codeBlock()?.textContent).toBe(CODE));
    expect(colours()).toEqual([]);

    await give();
    await waitFor(() => expect(colours().length).toBeGreaterThan(0));
    expect(colours().map((span) => span.className)).toEqual(
      expect.arrayContaining(['hljs-keyword', 'hljs-number']),
    );
    expect(codeBlock()?.textContent).toBe(CODE);
    expect(changes).toEqual([]);
  });

  it('stays plain where the app gives no grammars', async () => {
    render(note());
    await waitFor(() => expect(codeBlock()?.textContent).toBe(CODE));
    expect(colours()).toEqual([]);
  });
});
