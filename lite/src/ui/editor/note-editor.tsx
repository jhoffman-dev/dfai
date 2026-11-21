import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import type { EditorBridge } from './bridge.ts';
import { noteCompletions } from './completions.ts';
import { linkPills } from './link-pills.ts';
import { markdownStyle } from './markdown-style.ts';
import './editor.css';

function editorState(text: string, bridge: () => EditorBridge): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      history(),
      closeBrackets(),
      markdown({ base: markdownLanguage }),
      markdownStyle(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'Note text', spellcheck: 'true' }),
      placeholder('Start typing…'),
      highlightSelectionMatches(),
      linkPills(bridge),
      noteCompletions(bridge),
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) bridge().changed(() => update.view.state.doc.toString());
        if (update.focusChanged && !update.view.hasFocus) bridge().blurred();
      }),
    ],
  });
}

/**
 * CodeMirror on the note's raw markdown. Built once per note (the parent keys
 * it by path); React never re-renders it on a keystroke, and the text it was
 * opened with is the only text it is ever given.
 */
export function NoteEditor({
  initialText,
  autoFocus,
  bridge,
}: {
  initialText: string;
  autoFocus: boolean;
  bridge: EditorBridge;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(bridge);
  useEffect(() => {
    latest.current = bridge;
  });

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const view = new EditorView({ parent, state: editorState(initialText, () => latest.current) });
    latest.current.opened(initialText);
    if (autoFocus) view.focus();
    return () => view.destroy();
    // The editor owns its text once built: a new `initialText` is a new note, and a new key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="note-editor" />;
}
