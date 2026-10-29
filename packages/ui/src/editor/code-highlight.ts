import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  grammarFor,
  type CodeGrammar,
  type CodeLanguages,
  type HighlightedCode,
} from './code-languages.ts';

/*
 * Colours each code block in its language, drawn as decorations only, so the
 * saved bytes never see it (ADR-0003). A block whose grammar has not loaded
 * is drawn as its plain text and asks for it; when it arrives the editor is
 * told, and the block is coloured where it stands. A block with no language,
 * or one DFAI does not highlight, stays plain (#265).
 */

interface HighlightState {
  readonly decorations: DecorationSet;
  /** The grammars this note's blocks name that have not loaded yet, with how many blocks name each. */
  readonly waiting: ReadonlyMap<CodeGrammar, number>;
}

const highlightKey = new PluginKey<HighlightState>('codeHighlight');

type CodeBlock = { node: PmNode; pos: number };

/** The note's code blocks, without walking into any other block's text. */
function codeBlocksOf(doc: PmNode): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') blocks.push({ node, pos });
    return !node.isTextblock && !node.isAtom;
  });
  return blocks;
}

type Branch = HighlightedCode['children'][number];

/** The coloured runs of a highlighted tree, from `from`, each with its classes. */
function decorationsOf(nodes: readonly Branch[], from: number, classes: readonly string[] = []) {
  const decorations: Decoration[] = [];
  let at = from;
  for (const node of nodes) {
    if (node.type === 'text') {
      const to = at + node.value.length;
      if (classes.length > 0)
        decorations.push(Decoration.inline(at, to, { class: classes.join(' ') }));
      at = to;
    } else if (node.type === 'element') {
      const own = node.properties.className;
      const inner = Array.isArray(own) ? [...classes, ...own.map(String)] : classes;
      const drawn = decorationsOf(node.children, at, inner);
      decorations.push(...drawn.decorations);
      at = drawn.at;
    }
  }
  return { decorations, at };
}

function highlightDoc(doc: PmNode, languages: CodeLanguages): HighlightState {
  const decorations: Decoration[] = [];
  const waiting = new Map<CodeGrammar, number>();
  for (const { node, pos } of codeBlocksOf(doc)) {
    const grammar = grammarFor(node.attrs.language as string | null);
    if (grammar === null) continue;
    const tree = languages.highlight(grammar, node.textContent);
    if (tree === null) waiting.set(grammar, (waiting.get(grammar) ?? 0) + 1);
    else decorations.push(...decorationsOf(tree.children, pos + 1).decorations);
  }
  return { decorations: DecorationSet.create(doc, decorations), waiting };
}

/** Whether a change left every code block as it was: then the colours only move. */
function sameBlocks(before: PmNode, after: PmNode): boolean {
  const [was, now] = [codeBlocksOf(before), codeBlocksOf(after)];
  return was.length === now.length && was.every((block, at) => block.node === now[at]?.node);
}

/** Marks a transaction that only redraws: plugins that append edits leave it alone. */
export const REDRAW_ONLY = 'redrawOnly';

/** Whether every transaction in a round only redrew, changing nothing in the note. */
export const onlyRedraws = (transactions: readonly Transaction[]): boolean =>
  transactions.length > 0 &&
  transactions.every((transaction) => transaction.getMeta(REDRAW_ONLY) === true);

/**
 * Asks for each grammar the note waits on, and colours the note whenever one
 * it waits on arrives, whichever editor's ask brought it. A grammar whose
 * fetch failed is asked for again, fresh, when the note gains another block
 * in it: once per new block, never on each keystroke.
 */
function askForGrammars(languages: CodeLanguages) {
  return (view: { state: EditorState; dispatch: (tr: Transaction) => void }) => {
    const asked = new Set<CodeGrammar>();
    /** How many blocks named a grammar when its fetch failed. */
    const failedWith = new Map<CodeGrammar, number>();
    const waiting = () =>
      highlightKey.getState(view.state)?.waiting ?? new Map<CodeGrammar, number>();
    const stopListening = languages.onReady((grammar) => {
      if (!waiting().has(grammar)) return;
      // Nothing in the note changed: not an edit to save, nor a step to undo, nor one to append to.
      view.dispatch(
        view.state.tr
          .setMeta(highlightKey, grammar)
          .setMeta(REDRAW_ONLY, true)
          .setMeta('preventUpdate', true)
          .setMeta('addToHistory', false),
      );
    });
    const ask = () => {
      for (const [grammar, blocks] of waiting()) {
        if (asked.has(grammar) || blocks <= (failedWith.get(grammar) ?? 0)) continue;
        asked.add(grammar);
        void languages.load(grammar).then((ready) => {
          if (ready) return;
          // Its arrival from another editor's ask still colours the note (onReady).
          asked.delete(grammar);
          failedWith.set(grammar, waiting().get(grammar) ?? 0);
        });
      }
    };
    ask();
    return { update: ask, destroy: stopListening };
  };
}

function codeHighlightPlugin(languages: CodeLanguages): Plugin<HighlightState> {
  return new Plugin<HighlightState>({
    key: highlightKey,
    state: {
      init: (_, { doc }) => highlightDoc(doc, languages),
      apply: (tr, state, before) => {
        if (tr.getMeta(highlightKey) !== undefined) return highlightDoc(tr.doc, languages);
        if (!tr.docChanged) return state;
        if (!sameBlocks(before.doc, tr.doc)) return highlightDoc(tr.doc, languages);
        return { ...state, decorations: state.decorations.map(tr.mapping, tr.doc) };
      },
    },
    props: { decorations: (state) => highlightKey.getState(state)?.decorations ?? null },
    view: askForGrammars(languages),
  });
}

export interface CodeHighlightOptions {
  /** Where grammars come from; null leaves every code block plain. */
  languages: CodeLanguages | null;
}

export const CodeHighlight = Extension.create<CodeHighlightOptions>({
  name: 'codeHighlight',
  addOptions: () => ({ languages: null }),
  addProseMirrorPlugins() {
    const { languages } = this.options;
    return languages === null ? [] : [codeHighlightPlugin(languages)];
  },
});
