import { useEffect, useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { EditorDocument } from '@dfai/domain';
import { createReadingExtensions } from './editor/extensions.ts';
import { useCodeLanguages } from './editor/code-languages-context.ts';
import { showAsRead } from './editor/block-anchor.ts';

/**
 * A note's body, drawn to be read: the editor's own nodes, so headings, lists,
 * callouts and images look as they do in the note, but nothing can be typed.
 * A `[[link]]` in it opens its note, by click or by Enter, and a `#tag` the
 * tags page, where that is offered.
 */
export function NoteReading({
  doc,
  label,
  onFollowLink,
  onOpenTag,
  loadImage,
}: {
  doc: EditorDocument;
  /** What the body is named to assistive technology: "Body of <title>". */
  label: string;
  onFollowLink: (target: string) => void;
  /** Opens the notes with a tag, by its name as written. */
  onOpenTag?: (name: string) => void;
  loadImage: (src: string) => Promise<string | null>;
}) {
  const codeLanguages = useCodeLanguages();
  const extensions = useMemo(
    () => createReadingExtensions({ loadImage, codeLanguages }),
    [loadImage, codeLanguages],
  );
  const editor = useEditor(
    {
      extensions,
      editable: false,
      content: doc as object,
      editorProps: { attributes: { class: 'editor editor--reading', 'aria-label': label } },
    },
    [extensions],
  );

  // A longer excerpt ("Show more") or a re-read file arrives as a new document.
  useEffect(() => {
    if (editor !== null) showAsRead(editor, doc);
  }, [editor, doc]);

  const follow = (event: MouseEvent | KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const link = target?.closest('[data-wikilink]') ?? null;
    const tag = onOpenTag === undefined ? null : (target?.closest('[data-tag]') ?? null);
    if (link !== null) {
      event.preventDefault();
      onFollowLink(link.getAttribute('data-wikilink') ?? '');
    } else if (tag !== null) {
      event.preventDefault();
      onOpenTag?.(tag.getAttribute('data-tag') ?? '');
    }
  };

  return (
    // Delegated: the links inside are the interactive elements; this only
    // listens for them.
    <div
      className="note-reading"
      onClick={follow}
      onKeyDown={(event) => {
        if (event.key === 'Enter') follow(event);
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
