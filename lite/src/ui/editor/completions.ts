import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { folderOf, openLinkInText } from '../../application/index.ts';
import type { EditorBridge } from './bridge.ts';

/** Writes `target` as the link's name, closing the brackets unless they already are. */
function insertLinkTarget(view: EditorView, target: string, from: number, to: number): void {
  const closed = view.state.sliceDoc(to, to + 2) === ']]';
  view.dispatch({
    changes: { from, to, insert: closed ? target : `${target}]]` },
    selection: { anchor: from + target.length + 2 },
    userEvent: 'input.complete',
  });
}

function linkSource(bridge: () => EditorBridge) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const open = openLinkInText(line.text, context.pos - line.from);
    // An alias or a heading is being typed after the name: nothing to offer.
    if (open === null || /[|#^]/.test(open.query)) return null;
    const from = line.from + open.start + 2;
    const query = open.query;
    const suggestions = bridge().suggestNotes(query);
    const options: Completion[] = suggestions.map((note, rank) => ({
      label: note.title,
      detail: folderOf(note.path),
      boost: -rank,
      apply: (view, _completion, applyFrom, applyTo) =>
        insertLinkTarget(view, note.target, applyFrom, applyTo),
    }));
    const typed = query.trim();
    if (typed !== '' && !suggestions.some((note) => note.match === 'exact')) {
      options.push({
        label: `Create “${typed}”`,
        type: 'create',
        boost: -99,
        apply: (view, _completion, applyFrom, applyTo) => {
          insertLinkTarget(view, typed, applyFrom, applyTo);
          bridge().createLinkedNote(typed);
        },
      });
    }
    return { from, to: context.pos, options, filter: false };
  };
}

/** A tag starts after a space or at the line's start, so `a#b` and headings are left alone. */
const TAG_BEFORE_CARET = /(?:^|\s)#([\p{L}\p{N}_/-]+)$/u;

function tagSource(bridge: () => EditorBridge) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const match = TAG_BEFORE_CARET.exec(line.text.slice(0, context.pos - line.from));
    if (match === null) return null;
    const prefix = match[1] ?? '';
    const names = bridge()
      .suggestTags(prefix)
      .filter((name) => name !== prefix);
    if (names.length === 0) return null;
    return {
      from: context.pos - prefix.length,
      options: names.map((name) => ({ label: name, apply: name })),
      filter: false,
    };
  };
}

/** `[[` offers notes (and "Create"), `#` offers the tags already in the vault. */
export function noteCompletions(bridge: () => EditorBridge): Extension {
  return autocompletion({
    override: [linkSource(bridge), tagSource(bridge)],
    icons: false,
    activateOnTyping: true,
  });
}
