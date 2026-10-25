import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * Languages are registered one by one rather than pulling in all of highlight.js,
 * which would more than double the bundle for languages no note will use.
 */
const lowlight = createLowlight();
lowlight.register({ bash, css, json, markdown, python, rust, sql, typescript, xml, yaml });
lowlight.registerAlias({
  bash: ['sh', 'shell', 'zsh'],
  typescript: ['ts', 'js', 'javascript', 'jsx', 'tsx'],
  xml: ['html', 'svg'],
  yaml: ['yml'],
});
import type { MentionSuggestion, NoteSuggestion, TagSuggestion } from '@dfai/domain';
import { BlockId } from './block-id.ts';
import { BlockAnchor } from './block-anchor.ts';
import { RevealedBlock } from './revealed-block.ts';
import { BlockEmbed, type TransclusionSource } from './block-embed.tsx';
import { BlockDrop } from './block-drop.ts';
import { BlockHandle } from './block-handle.ts';
import type { BlockPicking } from './block-picking.ts';
import { Bookmark, TopLevelDocument, type BookmarkSource } from './bookmark.tsx';
import { LinkKeys } from './link-keys.ts';
import { ControlKeys } from './control-keys.ts';
import { EscapeUnused } from './escape-unused.ts';
import { QueryBlock, type QueryBlockSource } from './query-block.tsx';
import { Callout } from './callout.ts';
import { VaultImage } from './image.tsx';
import { ImageUploads, type EmbedImage } from './image-uploads.ts';
import {
  MentionSuggestionExtension,
  type CreatePerson,
  type MentionSuggestionView,
} from './mention-suggestion.ts';
import { PendingMention } from './pending-mention.ts';
import { PromoteLineButton, type PromoteLine } from './promote-line.ts';
import { PersonChips, type PersonFor } from './person-chips.ts';
import { RawBlock, type HighlightBlocks, type ReaderLinks } from './raw-block.ts';
import { TombstoneGuard } from './tombstone-guard.ts';
import { TrailingLine } from './trailing-line.ts';
import { WikiLink } from './wiki-link.ts';
import {
  WikiLinkSuggestion,
  type LinkedNoteMaker,
  type WikiSuggestionView,
} from './wiki-link-suggestion.ts';
import { SlashCommands, type SlashCommandView } from './slash-commands.ts';
import { TagHighlight } from './tag-highlight.ts';
import { TagSuggestionExtension, type TagSuggestionView } from './tag-suggestion.ts';

/**
 * The editor's node set, chosen to match what the markdown serializer can write.
 * Nothing is offered that cannot survive a round trip to markdown and back.
 */
export function createEditorExtensions({
  suggest,
  onView,
  onSlashView,
  suggestTags,
  onTagView,
  onOpenTag,
  offerLink,
  loadImage,
  embedImage,
  people = NO_PEOPLE,
  bookmarks = null,
  transclusions = null,
  queries = null,
  picking = null,
  promoteLine = null,
  createNote = null,
  readerLinks = null,
  highlights = null,
}: {
  suggest: (query: string) => NoteSuggestion[];
  onView: (view: WikiSuggestionView | null) => void;
  onSlashView: (view: SlashCommandView | null) => void;
  /** Tags offered after `#`. */
  suggestTags: (query: string) => readonly TagSuggestion[];
  onTagView: (view: TagSuggestionView | null) => void;
  /** Opens the notes with a tag, when one is clicked; null where tags do not open. */
  onOpenTag: ((name: string) => void) | null;
  /** Offers "Link to note" among the slash commands. */
  offerLink: boolean;
  loadImage: (src: string) => Promise<string | null>;
  /** Saves a pasted, dropped or picked image; null where images cannot be added. */
  embedImage: EmbedImage | null;
  /** `@` mentions and the chips they are drawn as; left out, `@` is only a character. */
  people?: EditorPeople;
  /** Where bookmark cards read their notes; left out, a bookmark is drawn as its link. */
  bookmarks?: BookmarkSource | null;
  /** Where shown blocks read their notes; left out, one is drawn as its embed's link. */
  transclusions?: TransclusionSource | null;
  /** Where query blocks are answered; left out, one is drawn as its code. */
  queries?: QueryBlockSource | null;
  /** A note's headings and blocks after `[[Note#`; left out, `#` offers nothing. */
  picking?: BlockPicking | null;
  /** Makes a checklist line a task; left out, no line offers it. */
  promoteLine?: PromoteLine | null;
  /** Makes a note of a name typed after `[[` that no note has; left out, none is offered. */
  createNote?: LinkedNoteMaker | null;
  /** Which raw blocks offer to open their place in a reader (#506); left out, none does. */
  readerLinks?: ReaderLinks | null;
  /** A literature note's highlights, which its raw blocks are drawn as (#523); left out, as source. */
  highlights?: HighlightBlocks | null;
}) {
  return [
    ...baseExtensions,
    ControlKeys,
    RawBlock.configure({ readerLinks, highlights }),
    TombstoneGuard,
    TagHighlight.configure({ onOpen: onOpenTag }),
    PersonChips.configure({ personFor: people.personFor }),
    PendingMention,
    MentionSuggestionExtension.configure({
      suggest: people.suggest,
      onView: people.onView,
      createPerson: people.create,
      notLinked: people.notLinked ?? (() => {}),
    }),
    VaultImage.configure({ loadImage }),
    Bookmark.configure({ source: bookmarks }),
    BlockEmbed.configure({
      source: transclusions,
      reading: (loadBlockImage) => createReadingExtensions({ loadImage: loadBlockImage }),
    }),
    QueryBlock.configure({ source: queries }),
    LinkKeys,
    RevealedBlock,
    ImageUploads.configure({ embed: embedImage }),
    WikiLinkSuggestion.configure({ suggest, onView, blocks: picking, createNote }),
    TagSuggestionExtension.configure({ suggest: suggestTags, onView: onTagView }),
    SlashCommands.configure({
      onView: onSlashView,
      offerLink,
      offerImage: embedImage !== null,
      offerQuery: queries !== null,
    }),
    PromoteLineButton.configure({ promote: promoteLine }),
    BlockHandle.configure({ highlights }),
    BlockDrop,
    EscapeUnused,
  ];
}

/** What the editor knows of the vault's people. */
export interface EditorPeople {
  /** People for what has been typed after `@`. */
  readonly suggest: (query: string) => readonly MentionSuggestion[];
  readonly onView: (view: MentionSuggestionView | null) => void;
  /** Null where a person cannot be made from the note. */
  readonly create: CreatePerson | null;
  /** The chip for a link that opens a person. */
  readonly personFor: PersonFor;
  /** A person was made, but the note changed first and no link was written to them. */
  readonly notLinked?: (name: string) => void;
}

const NO_PEOPLE: EditorPeople = {
  suggest: () => [],
  onView: () => {},
  create: null,
  personFor: () => null,
};

/**
 * The nodes a note is drawn with when it is read rather than edited — a feed's
 * cards. The same schema as the editor, so a note reads the same in both, with
 * nothing that only typing needs: no suggestions, no slash commands.
 */
export function createReadingExtensions({
  loadImage,
}: {
  loadImage: (src: string) => Promise<string | null>;
}) {
  return [
    ...baseExtensions,
    RawBlock,
    TagHighlight,
    VaultImage.configure({ loadImage }),
    Bookmark,
    // Drawn as its link: a block shown inside a shown block is not opened in turn.
    BlockEmbed,
    // Drawn as its code: a note read elsewhere is not the note `this` names.
    QueryBlock,
  ];
}

const baseExtensions = [
  StarterKit.configure({
    // Replaced below by one that holds bookmark cards, which nothing else may.
    document: false,
    // Markdown has no underline, so offering it would produce HTML in a .md file.
    underline: false,
    link: { openOnClick: false },
    // Replaced below by the highlighting version, which keeps the same schema.
    codeBlock: false,
    // Where a dragged block will land (#569): a line drawn by the stylesheet, in the accent.
    dropcursor: { color: false, width: 2, class: 'editor-drop-line' },
    // Replaced below by one that does not count a hidden tombstone as the note's end.
    trailingNode: false,
  }),
  TrailingLine,
  CodeBlockLowlight.configure({ lowlight, languageClassPrefix: 'language-' }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  TopLevelDocument,
  Callout,
  WikiLink,
  BlockId,
  BlockAnchor,
];
