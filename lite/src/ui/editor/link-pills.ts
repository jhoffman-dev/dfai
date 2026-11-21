import { Prec, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { EditorBridge } from './bridge.ts';
import { linkAt, noteSpans, tagAt } from './note-spans.ts';

const linkMark = Decoration.mark({ class: 'cm-link-pill' });
const ghostLinkMark = Decoration.mark({ class: 'cm-link-pill is-unresolved' });
const tagMark = Decoration.mark({ class: 'cm-tag-pill' });

function pillsOf(view: EditorView, bridge: EditorBridge): DecorationSet {
  const { links, tags } = view.state.field(noteSpans);
  const ranges = [
    ...links.map((link) =>
      (bridge.resolves(link.target) ? linkMark : ghostLinkMark).range(link.from, link.to),
    ),
    ...tags.map((tag) => tagMark.range(tag.from, tag.to)),
  ];
  return Decoration.set(ranges, true);
}

/**
 * Links and tags drawn as pills, followed by ⌘/Ctrl-click, and a link by
 * Enter (or ⌘/Ctrl-Enter) with the caret inside its brackets.
 */
export function linkPills(bridge: () => EditorBridge): Extension {
  const pills = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = pillsOf(view, bridge());
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = pillsOf(update.view, bridge());
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  const followAtCaret = (view: EditorView): boolean => {
    const { main } = view.state.selection;
    if (!main.empty) return false;
    const link = linkAt(view.state, main.head);
    if (link === null) return false;
    bridge().followLink(link.target);
    return true;
  };

  const clicks = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (at === null) return false;
      const link = linkAt(view.state, at, { edges: true });
      const tag = link === null ? tagAt(view.state, at) : null;
      if (link !== null) bridge().followLink(link.target);
      else if (tag !== null) bridge().openTag(tag.name);
      else return false;
      event.preventDefault();
      return true;
    },
  });

  const keys = Prec.high(
    keymap.of([
      { key: 'Enter', run: followAtCaret },
      { key: 'Mod-Enter', run: followAtCaret },
    ]),
  );
  return [noteSpans, pills, clicks, keys];
}
