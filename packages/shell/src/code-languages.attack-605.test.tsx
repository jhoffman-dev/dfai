// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { parseMarkdownBody, serializeMarkdownBody } from '@dfai/adapters';
import type { EditorDocument } from '@dfai/domain';
import {
  CODE_GRAMMAR_IMPORTS,
  CodeLanguagesProvider,
  NoteEditor,
  createCodeLanguages,
  grammarFor,
  type CodeGrammar,
} from '@dfai/ui';
import { chunkOf } from './on-first-use.ts';

/*
 * Attack on PR #605 (#265): the code block's schema moved from the lowlight
 * extension to StarterKit's own. Notes already on disk must open, colour and
 * save byte for byte; and a grammar's chunk recovers from an aborted fetch and
 * a truncated file as a page does.
 */

beforeAll(() => {
  const empty = () => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = empty;
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOTES: Readonly<Record<string, string>> = {
  'a js fence': 'Lead.\n\n```js\nconst kale = 55;\n```\n',
  'an upper-case JS fence': '```JS\nconst kale = 55;\n```\n\nAfter.\n',
  'a bare fence': '```\nplain text\n```\n',
  'an info string': '```ts title="barn.ts" {1,3}\nlet hens = 3;\n```\n',
  'a tilde fence': '~~~python\ndef lantern():\n    return 42\n~~~\n',
  'indented code': 'Lead.\n\n    indented = True\n    more = 1\n',
  'a nested fence': '````markdown\n```js\nnested();\n```\n````\n',
  'an empty fence': '```yaml\n```\n',
  'unknown and aliases':
    '```cobol\nDISPLAY "HI".\n```\n\n```zsh\necho hi\n```\n\n```  Py  \nx = 1\n```\n',
  'unicode and CRLF-free tabs': '```rs\nfn main() {\n\tprintln!("ünïcødé 🌱");\n}\n```\n',
};

const realGrammars = () =>
  createCodeLanguages(
    async (grammar: CodeGrammar) => (await CODE_GRAMMAR_IMPORTS[grammar]()).default,
  );

type WithEditor = HTMLElement & { editor?: { getJSON: () => unknown } };

describe('#265 attack: notes already on disk round-trip through the new code block', () => {
  it.each(Object.entries(NOTES))(
    '%s opens, is coloured, and saves byte for byte',
    async (_, body) => {
      const parsed = parseMarkdownBody(body);
      const changes: EditorDocument[] = [];
      render(
        <CodeLanguagesProvider value={realGrammars()}>
          <NoteEditor
            doc={parsed.doc}
            onChange={(next) => changes.push(next)}
            onFollowLink={() => {}}
            suggestNotes={() => []}
            loadImage={async () => null}
          />
        </CodeLanguagesProvider>,
      );
      const dom = await waitFor(() => {
        const found = document.querySelector<WithEditor>('.ProseMirror');
        expect(found?.editor).toBeDefined();
        return found as WithEditor;
      });
      // Every block in a language DFAI highlights is coloured once its grammar arrives.
      const highlighted = (parsed.doc.content ?? []).filter(
        (node) =>
          node.type === 'codeBlock' &&
          (node.content?.length ?? 0) > 0 &&
          grammarFor(node.attrs?.['language'] as string | null) !== null,
      ).length;
      await waitFor(() => {
        const coloured = [...document.querySelectorAll('pre code')].filter(
          (block) => block.querySelector('[class*="hljs-"]') !== null,
        );
        expect(coloured.length).toBe(highlighted);
      });

      const shown = dom.editor?.getJSON() as EditorDocument;
      expect(serializeMarkdownBody({ originalBody: body, parsed, doc: shown })).toBe(body);
      expect(changes).toEqual([]);
    },
  );
});

describe('#265 attack: a grammar chunk that aborts, then arrives truncated, then loads', () => {
  it('colours on the third ask, fetched the third time under a fresh address', async () => {
    const asked: string[] = [];
    const module = await CODE_GRAMMAR_IMPORTS.sql();
    const chunk = chunkOf<typeof module>({
      load: () => {
        asked.push('load');
        return asked.length === 1
          ? Promise.reject(new TypeError('Importing a module script failed.'))
          : Promise.reject(new SyntaxError('Unexpected end of script'));
      },
      loadAgain: (attempt) => {
        asked.push(`again ${attempt}`);
        return Promise.resolve(module);
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const languages = createCodeLanguages(
      async (_, { fresh }) => (await chunk.load({ fresh })).default,
    );

    expect(await languages.load('sql')).toBe(false);
    expect(await languages.load('sql')).toBe(false);
    expect(await languages.load('sql')).toBe(true);
    expect(asked).toEqual(['load', 'load', 'again 3']);
    expect(languages.highlight('sql', 'SELECT 1;')).not.toBeNull();
  });
});
