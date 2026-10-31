// @vitest-environment jsdom
/**
 * Esc from the peek's text closes it (slice 6b): ProseMirror prevents the
 * default of every Escape pressed in the editor, so the peek closes on one
 * the editor says it left alone, and stays up for one the editor used.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { EditorContent, useEditor } from '@tiptap/react';
import { createEditorExtensions } from '../editor/extensions.ts';
import { PeekDialog } from './peek-dialog.tsx';

function Text() {
  const editor = useEditor({
    extensions: createEditorExtensions({
      suggest: () => [],
      onView: () => {},
      onSlashView: () => {},
      suggestTags: () => [],
      onTagView: () => {},
      onOpenTag: null,
      offerLink: false,
      loadImage: async () => null,
      embedImage: null,
    }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    },
  });
  return <EditorContent editor={editor} />;
}

function peek(onClose: () => void, covered?: () => boolean) {
  render(
    <PeekDialog
      title="Plan"
      position={null}
      status="Saved"
      onStep={vi.fn()}
      onClose={onClose}
      {...(covered !== undefined && { covered })}
    >
      <Text />
    </PeekDialog>,
  );
}

const editorElement = () => document.querySelector<HTMLElement>('.ProseMirror');
const escape = { key: 'Escape', keyCode: 27 };

describe('PeekDialog — Esc from the text', () => {
  it('closes on an Escape the editor left alone, though ProseMirror prevented it', async () => {
    const onClose = vi.fn();
    peek(onClose);
    await waitFor(() => expect(editorElement()).not.toBeNull());
    const text = editorElement() as HTMLElement;
    text.focus();
    fireEvent.keyDown(text, escape);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays up for an Escape something in the text answered first', async () => {
    const onClose = vi.fn();
    peek(onClose);
    await waitFor(() => expect(editorElement()).not.toBeNull());
    const text = editorElement() as HTMLElement;
    // A suggestion list's handler, on the way down: before the editor sees the key.
    text.parentElement?.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') event.preventDefault();
      },
      { capture: true },
    );
    text.focus();
    fireEvent.keyDown(text, escape);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays up for an Escape pressed while something is open above it, wherever the focus is', async () => {
    // The search palette over the peek, its field not yet focused: the Escape is the palette's.
    const onClose = vi.fn();
    peek(onClose, () => true);
    await waitFor(() => expect(editorElement()).not.toBeNull());
    const text = editorElement() as HTMLElement;
    text.focus();
    fireEvent.keyDown(text, escape);
    expect(onClose).not.toHaveBeenCalled();
  });
});
