import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { openHowFrom, type OpenHow } from './open-how.ts';
import type { Editor } from '@tiptap/core';
import {
  IMAGE_PICKER_ACCEPT,
  type EditorDocument,
  type HighlightView,
  type LinkFragment,
  type MentionSuggestion,
  type NoteSuggestion,
  type PersonChip,
  type TagSuggestion,
} from '@dfai/domain';
import { createEditorExtensions } from './editor/extensions.ts';
import type { HighlightBlocks, ReaderLinks } from './editor/raw-block.ts';
import {
  HighlightDrafts,
  LEAVING_WRITE_WAIT_MS,
  refusedAfter,
  type KeptComment,
  type LostDraft,
  type WriteComment,
} from './editor/highlight-drafts.ts';
import { redrawHighlightBlocks } from './editor/raw-block.ts';
import { showAsRead } from './editor/block-anchor.ts';
import type { LinkedNoteMaker, WikiSuggestionView } from './editor/wiki-link-suggestion.ts';
import { IMAGE_REQUEST, LINK_REQUEST, type SlashCommandView } from './editor/slash-commands.ts';
import { addImages, type EmbedImage } from './editor/image-uploads.ts';
import { SuggestionPopup } from './editor/suggestion-popup.tsx';
import type { TagSuggestionView } from './editor/tag-suggestion.ts';
import { TagSuggestionPopup } from './editor/tag-suggestion-popup.tsx';
import type { MentionSuggestionView } from './editor/mention-suggestion.ts';
import { MentionSuggestionPopup } from './editor/mention-suggestion-popup.tsx';
import { LinkSuggestionPopup } from './editor/link-suggestion-popup.tsx';
import type { BlockPicking } from './editor/block-picking.ts';
import type { PromoteLine } from './editor/promote-line.ts';
import { withoutPendingMentions } from './editor/pending-mention.ts';
import { redrawPersonChips } from './editor/person-chips.ts';
import { useLinkMenu } from './note-link-menu.tsx';
import { useBlockMenu } from './note-block-menu.tsx';
import {
  useBlockPicking,
  useBookmarkSource,
  useLatest,
  useQueryBlockSource,
  useReveal,
  useTransclusionSource,
  type NoteBookmarks,
  type NoteQueryBlocks,
  type NoteTransclusions,
} from './note-editor-sources.ts';

export type { NoteBookmarks, NoteQueryBlocks, NoteTransclusions } from './note-editor-sources.ts';

/** The vault's people, as a note needs them for `@` and for drawing links to them. */
export interface NotePeople {
  /** People for what has been typed after `@`. */
  readonly suggest: (query: string) => readonly MentionSuggestion[];
  /** Makes a person of a new name, resolving to what a link to them is written as. */
  readonly create: (name: string) => Promise<string>;
  /** The chip for a link that opens a person, or null. */
  readonly personFor: (target: string) => PersonChip | null;
  /** A person was made, but the note changed first and no link was written to them. */
  readonly notLinked: (name: string) => void;
}

/** A block or heading to bring into view once the note is showing, and which time it was asked. */
export interface NoteReveal {
  readonly fragment: LinkFragment;
  readonly key: unknown;
  /** Called once the block is in view: the request is spent, and not made again. */
  readonly done?: () => void;
}

/** What the page around the editor may ask of it. */
export interface NoteEditorHandle {
  /**
   * Writes `[[target]]` where the cursor is — or, if the note has not been
   * clicked into since it opened, at the end of the note, since there is no
   * cursor to mean.
   */
  insertLink: (target: string) => void;
  /** Opens the file picker for an image, which goes in where the cursor is. */
  pickImage: () => void;
}

/**
 * The note, editable. Markdown shortcuts work as you type — `# `, `- `, `**bold**` —
 * `[[` offers notes to link to, `/` offers blocks to insert, and the document is
 * reported back as ProseMirror JSON for the serializer to write.
 */
export function NoteEditor({
  doc,
  onChange,
  onFollowLink,
  suggestNotes,
  suggestTags,
  onOpenTag,
  loadImage,
  onRequestLink,
  embedImage,
  people,
  bookmarks,
  transclusions,
  queries,
  picking,
  reveal = null,
  onPromoteLine,
  onCreateNote,
  highlightLinks,
  highlights,
  ref,
}: {
  doc: EditorDocument;
  onChange: (doc: EditorDocument) => void;
  /** Opens the note a link names, at the heading or block it names when it does. */
  /** Opens the note a link names; `how` is where the click asked for it. */
  onFollowLink: (target: string, heading?: string | null, how?: OpenHow) => void;
  suggestNotes: (query: string) => NoteSuggestion[];
  /** Tags offered after `#` and a letter; left out, none are. */
  suggestTags?: (query: string) => readonly TagSuggestion[];
  /** Opens the notes with a tag, when one is clicked. */
  onOpenTag?: (name: string) => void;
  loadImage: (src: string) => Promise<string | null>;
  /** Opens the note picker for `/link`; the pick comes back through `insertLink`. */
  onRequestLink?: () => void;
  /**
   * Saves an image pasted, dropped or picked into the note, resolving to what
   * the note should point at. Left out, the note takes no images.
   */
  embedImage?: EmbedImage;
  /** `@` offers people and links to them draw as chips; left out, neither happens. */
  people?: NotePeople;
  /** Bookmarks drawn as cards of the notes they open; left out, each is drawn as its link. */
  bookmarks?: NoteBookmarks;
  /** Shown blocks drawn live from their notes; left out, each is drawn as its embed. */
  transclusions?: NoteTransclusions;
  /** Query blocks answered live, `this` being this note; left out, each is drawn as its code. */
  queries?: NoteQueryBlocks;
  /** A note's headings and blocks after `[[Note#`; left out, `#` offers nothing. */
  picking?: BlockPicking;
  /** A block or heading to bring into view: where a followed link pointed. */
  reveal?: NoteReveal | null;
  /** Makes the checklist line the caret is in a task (P30-03); left out, none is offered. */
  onPromoteLine?: PromoteLine;
  /** Makes a note of a name typed after `[[` that no note has (#465); left out, `[[` offers none. */
  onCreateNote?: LinkedNoteMaker;
  /** The highlights of a literature note that open in a reader, and the words that offer it (#506). */
  highlightLinks?: HighlightLinks | null;
  /** A literature note's highlights, drawn as quotes with comments to type in (#523); left out, as source. */
  highlights?: NoteHighlights | null;
  ref?: Ref<NoteEditorHandle>;
}) {
  const [links, setLinks] = useState<WikiSuggestionView | null>(null);
  const [commands, setCommands] = useState<SlashCommandView | null>(null);
  const [tags, setTags] = useState<TagSuggestionView | null>(null);
  // Read through a ref: the vault's tags change as notes are saved, and a new
  // function each time would rebuild the editor under the caret.
  const tagSuggester = useLatest(suggestTags);
  const stableSuggestTags = useCallback(
    (query: string) => tagSuggester.current?.(query) ?? [],
    [tagSuggester],
  );
  const tagOpener = useLatest(onOpenTag);
  const opensTags = onOpenTag !== undefined;
  const stableOpenTag = useCallback((name: string) => tagOpener.current?.(name), [tagOpener]);
  const offerLink = onRequestLink !== undefined;
  const embed = useLatest(embedImage);
  const offerImage = embedImage !== undefined;
  const stableEmbed = useCallback<EmbedImage>(
    (file, origin) => {
      const current = embed.current;
      return current === undefined
        ? Promise.reject(new Error('Images cannot be added here.'))
        : current(file, origin);
    },
    [embed],
  );

  // Read through a ref, as the tags are: the people change as notes are saved.
  const [mentions, setMentions] = useState<MentionSuggestionView | null>(null);
  const peopleNow = useLatest(people);
  const hasPeople = people !== undefined;
  const editorPeople = useMemo(
    () =>
      hasPeople
        ? {
            suggest: (query: string) => peopleNow.current?.suggest(query) ?? [],
            onView: setMentions,
            create: (name: string) =>
              peopleNow.current === undefined
                ? Promise.reject(new Error('People cannot be added here.'))
                : peopleNow.current.create(name),
            personFor: (target: string) => peopleNow.current?.personFor(target) ?? null,
            notLinked: (name: string) => peopleNow.current?.notLinked(name),
          }
        : undefined,
    [hasPeople, peopleNow],
  );

  // Read through a ref, as the tags are: a new function each render would rebuild the editor.
  const promoter = useLatest(onPromoteLine);
  const promotes = onPromoteLine !== undefined;
  const stablePromote = useCallback<PromoteLine>((line) => promoter.current?.(line), [promoter]);
  const creator = useLatest(onCreateNote);
  const creates = onCreateNote !== undefined;
  const stableCreate = useMemo<LinkedNoteMaker>(
    () => ({
      make: (name) =>
        creator.current?.make(name) ?? Promise.reject(new Error('Nothing can be made here.')),
      // Read when asked: the vault's notes change without the editor being built again.
      named: (name) => creator.current?.named(name) ?? true,
      notLinked: (name) => creator.current?.notLinked?.(name),
    }),
    [creator],
  );

  const readerLinks = useReaderLinks(highlightLinks ?? null);
  const highlightBlocks = useHighlightBlocks(highlights ?? null, loadImage);
  const bookmarkSource = useBookmarkSource(bookmarks);
  const transclusionSource = useTransclusionSource(transclusions);
  const queryBlockSource = useQueryBlockSource(queries);
  const blockPicking = useBlockPicking(picking);

  const extensions = useMemo(
    () =>
      createEditorExtensions({
        suggest: suggestNotes,
        onView: setLinks,
        onSlashView: setCommands,
        suggestTags: stableSuggestTags,
        onTagView: setTags,
        onOpenTag: opensTags ? stableOpenTag : null,
        offerLink,
        loadImage,
        embedImage: offerImage ? stableEmbed : null,
        ...(editorPeople !== undefined && { people: editorPeople }),
        bookmarks: bookmarkSource,
        transclusions: transclusionSource,
        queries: queryBlockSource,
        picking: blockPicking,
        promoteLine: promotes ? stablePromote : null,
        createNote: creates ? stableCreate : null,
        readerLinks,
        highlights: highlightBlocks,
      }),
    [
      readerLinks,
      highlightBlocks,
      promotes,
      stablePromote,
      creates,
      stableCreate,
      editorPeople,
      bookmarkSource,
      transclusionSource,
      queryBlockSource,
      blockPicking,
      suggestNotes,
      stableSuggestTags,
      opensTags,
      stableOpenTag,
      loadImage,
      offerLink,
      offerImage,
      stableEmbed,
    ],
  );

  /**
   * The document this editor is showing, to tell its own typing from a document
   * handed to it. Every keystroke comes back as a new `doc` prop, and replacing
   * the content on one of those would take the cursor with it.
   */
  const shown = useRef(doc);

  /** Whether the note has been clicked or tabbed into, which is what gives it a cursor. */
  const hasCursor = useRef(false);

  const editor = useEditor({
    extensions,
    content: doc as object,
    editorProps: { attributes: { class: 'editor', 'aria-label': 'Note' } },
    onFocus: () => {
      hasCursor.current = true;
    },
    onUpdate: ({ editor: instance }) => {
      // A person still being made is the editor's placeholder, not the note's.
      const typed = withoutPendingMentions(instance.getJSON()) as EditorDocument;
      shown.current = typed;
      onChange(typed);
    },
  });

  // The chips follow the vault's people: a person added or removed elsewhere
  // changes how links already in the note are drawn.
  const personFor = people?.personFor;
  useEffect(() => {
    if (editor !== null && personFor !== undefined) redrawPersonChips(editor);
  }, [editor, personFor]);

  // Which quotes are highlights can change with no change to their own bytes.
  const highlightReading = highlights?.viewOf;
  useEffect(() => {
    if (editor !== null && highlightReading !== undefined) {
      redrawHighlightBlocks(editor, highlightBlocks);
    }
  }, [editor, highlightReading, highlightBlocks]);

  useEffect(() => {
    if (editor === null || onRequestLink === undefined) return;
    const element = editor.view.dom;
    const answer = () => onRequestLink();
    element.addEventListener(LINK_REQUEST, answer);
    return () => element.removeEventListener(LINK_REQUEST, answer);
  }, [editor, onRequestLink]);

  const imagePicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editor === null || !offerImage) return;
    const element = editor.view.dom;
    const answer = () => imagePicker.current?.click();
    element.addEventListener(IMAGE_REQUEST, answer);
    return () => element.removeEventListener(IMAGE_REQUEST, answer);
  }, [editor, offerImage]);

  useImperativeHandle(
    ref,
    () => ({
      insertLink: (target) => {
        if (editor !== null) insertLinkInto(editor, { target, atCursor: hasCursor.current });
      },
      pickImage: () => imagePicker.current?.click(),
    }),
    [editor],
  );

  const addPicked = (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])];
    // Cleared, so picking the same file again still counts as a choice.
    input.value = '';
    if (editor === null || files.length === 0) return;
    // Without a cursor yet, the image goes at the end, as a link from the menu does.
    const at = hasCursor.current ? editor.state.selection.from : editor.state.doc.content.size;
    addImages(editor, { files, at, origin: 'file', embed: stableEmbed });
  };

  // A note re-read from disk — the other pane saved it, or the watcher noticed
  // something else did — arrives as a different document, and has to reach the
  // screen. Without this the pane keeps the old text and writes it back over
  // the file it has just re-read.
  useEffect(() => {
    if (editor === null || doc === shown.current) return;
    shown.current = doc;
    showAsRead(editor, doc);
  }, [editor, doc]);

  const linkMenu = useLinkMenu({ editor, onFollowLink });
  const blockMenu = useBlockMenu({ editor, highlights: highlightBlocks });

  // Delegated rather than bound per link, so links added while typing work too.
  const followLink = (event: {
    target: EventTarget | null;
    preventDefault: () => void;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
  }) => {
    const element =
      event.target instanceof HTMLElement ? event.target.closest('[data-wikilink]') : null;
    if (element === null) return;
    event.preventDefault();
    const target = element.getAttribute('data-wikilink') ?? '';
    const heading = element.getAttribute('data-heading');
    // A link to a heading or a block opens its note there (P26-03); ⌘-click
    // opens it in a new tab and ⌘⇧-click beside, as everywhere else.
    onFollowLink(target, heading, openHowFrom(event));
  };

  useReveal(editor, reveal);

  // A link drawn as a role="link" with a tab stop — a shown highlight's chip,
  // "Open in PDF", an embed's name — follows on Enter as a link does, with the
  // same modifiers. Only those: Enter typed in the text is the editor's.
  const followFromKeyboard = (event: Parameters<typeof followLink>[0] & { key: string }) => {
    const onLink =
      event.target instanceof HTMLElement && event.target.matches('[role="link"][data-wikilink]');
    if (event.key === 'Enter' && onLink) followLink(event);
  };

  return (
    <div onClick={followLink} onKeyDown={followFromKeyboard} {...linkMenu.handlers}>
      <EditorContent editor={editor} className="editor-host" />
      {linkMenu.overlay}
      {blockMenu}
      {offerImage && (
        <input
          ref={imagePicker}
          hidden
          type="file"
          accept={IMAGE_PICKER_ACCEPT}
          multiple
          aria-label="Choose an image"
          tabIndex={-1}
          onChange={(event) => addPicked(event.currentTarget)}
        />
      )}

      {links !== null && <LinkSuggestionPopup view={links} />}

      {tags !== null && <TagSuggestionPopup view={tags} />}

      {mentions !== null && <MentionSuggestionPopup view={mentions} />}

      {commands !== null && (
        <SuggestionPopup
          label="Insert block"
          items={commands.items}
          selected={commands.selected}
          rect={commands.rect}
          onPick={(id) => {
            const command = commands.items.find((candidate) => candidate.id === id);
            if (command !== undefined) commands.insert(command);
          }}
        />
      )}
    </div>
  );
}

/**
 * A wiki link node, and nothing after it: a space left untyped at the end of
 * a line is written to the file as `&#x20;`, which nobody wants in markdown.
 * At the end of the note it goes in a paragraph of its own, after whatever the
 * note ends with, rather than into a heading or a list that happens to be last.
 */
function insertLinkInto(
  editor: Editor,
  { target, atCursor }: { target: string; atCursor: boolean },
) {
  const link = { type: 'wikiLink', attrs: { target, heading: null, alias: null } };
  if (atCursor) {
    editor.chain().focus().insertContent(link).run();
    return;
  }
  const end = editor.state.doc.content.size;
  const last = editor.state.doc.lastChild;
  // An empty last paragraph is room already made for it.
  const content =
    last?.type.name === 'paragraph' && last.content.size === 0
      ? { at: end - 1, node: link }
      : { at: end, node: { type: 'paragraph', content: [link] } };
  editor.chain().insertContentAt(content.at, content.node).focus('end').run();
}

/** Which highlights of a literature note offer to open in its reader, and in what words ("Open in PDF"). */
export interface HighlightLinks {
  readonly label: string;
  readonly ids: ReadonlySet<string>;
}

/**
 * The raw blocks' reader links, read through a ref: the highlights change
 * as the note is saved, and a new set each time would rebuild the editor.
 */
function useReaderLinks(links: HighlightLinks | null): ReaderLinks | null {
  const latest = useLatest(links);
  const offers = links !== null;
  return useMemo(
    () =>
      offers
        ? {
            labelFor: (id: string) =>
              latest.current?.ids.has(id) === true ? latest.current.label : null,
          }
        : null,
    [offers, latest],
  );
}

/** A literature note's highlights as its editor draws them (#523), and the write of a comment. */
export interface NoteHighlights {
  /** The highlight a block of the note is — its markdown and `^id` — or null when it is none. */
  readonly viewOf: (block: {
    readonly markdown: string;
    readonly id: string;
  }) => HighlightView | null;
  /**
   * Writes a highlight's comment over `base`, the comment its field started
   * from; rejects with why it could not, `HighlightCommentChangedError` when the
   * note's comment is not `base` any more.
   */
  readonly editComment: WriteComment;
  /**
   * Told, as the editor goes, of the words typed in comments that could not be
   * written, each with the comment it was typed over: none when every one was.
   */
  readonly onUnwrittenComments?: (lost: readonly LostDraft[]) => void;
  /** Comments kept from the last time the note closed unwritten, put back in their fields. */
  readonly recovered?: readonly KeptComment[];
  /**
   * Handed, while the editor is open, the write of every comment typed and not
   * yet written, over the comment it started from — for when every pane's work
   * is written (another vault opening, the window closing). The fields keep
   * their words. Handed null as the editor goes.
   */
  readonly onWritePending?: (writePending: (() => Promise<void>) | null) => void;
  /**
   * Removes a highlight by the literature note's own write, as a block's
   * Delete asks (#569), telling the person when it cannot; left out, a
   * highlight's Delete is not offered.
   */
  readonly removeHighlight?: (id: string) => void;
}

/**
 * The raw blocks' highlights, read through refs as the reader links are: a
 * note saved hands over a new reading, and a new object each time would
 * rebuild the editor. Comments typed and not written when the editor goes are
 * written to the note they were typed in. Another note is another editor (the
 * pane keys its page by note); one moved under the pane keeps this editor, and
 * its drafts are written to where it is now, through the latest write.
 */
function useHighlightBlocks(
  highlights: NoteHighlights | null,
  loadImage: (src: string) => Promise<string | null>,
): HighlightBlocks | null {
  const latest = useLatest(highlights);
  const images = useLatest(loadImage);
  const [drafts] = useState(() => {
    const made = new HighlightDrafts();
    made.restore(highlights?.recovered ?? []);
    return made;
  });
  const recovered = highlights?.recovered;
  useEffect(() => {
    if (recovered !== undefined) drafts.restore(recovered);
  }, [drafts, recovered]);
  const offers = highlights !== null;
  const removes = highlights?.removeHighlight !== undefined;
  // The last highlights the note had: a note read again as no literature note
  // any more still has the words typed in its fields, and they go through these.
  const lastHeld = useRef(highlights);
  useEffect(() => {
    if (highlights !== null) lastHeld.current = highlights;
    else if (lastHeld.current !== null) {
      writeAsLeaving(drafts, lastHeld.current);
      // Written and told of: the editor going after this has nothing more to say.
      lastHeld.current = null;
    }
  }, [highlights, drafts]);
  useEffect(
    () => () => {
      const leaving = latest.current ?? lastHeld.current;
      if (leaving !== null) writeAsLeaving(drafts, leaving);
    },
    [drafts, latest],
  );
  const handOver = highlights?.onWritePending;
  useEffect(() => {
    if (handOver === undefined) return;
    handOver(() => drafts.writeUnwritten(writeThrough(latest)));
    return () => handOver(null);
  }, [handOver, drafts, latest]);
  return useMemo(
    () =>
      offers
        ? {
            viewOf: (block) => latest.current?.viewOf(block) ?? null,
            editComment: writeThrough(latest),
            drafts,
            loadImage: (src) => images.current(src),
            ...(removes && { remove: (id: string) => latest.current?.removeHighlight?.(id) }),
          }
        : null,
    [offers, removes, latest, images, drafts],
  );
}

/** Writes every draft through `leaving`, and tells it of the words that could not be. */
function writeAsLeaving(drafts: HighlightDrafts, leaving: NoteHighlights): void {
  const write = refusedAfter(leaving.editComment, LEAVING_WRITE_WAIT_MS);
  void drafts.flush(write).then((lost) => leaving.onUnwrittenComments?.(lost));
}

/** The write of the highlights as they are now: a note moved keeps its editor, and writes to where it is. */
const writeThrough =
  (latest: { readonly current: NoteHighlights | null }): WriteComment =>
  (edit) =>
    latest.current?.editComment(edit) ??
    Promise.reject(new Error('This note holds no highlights now.'));
