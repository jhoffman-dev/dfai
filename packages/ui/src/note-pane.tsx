import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { OpenHow } from './open-how.ts';
import {
  duplicatesTitle,
  isPersonType,
  TITLE_KEY,
  type EditorDocument,
  type NoteLinks,
  type NoteSuggestion,
  type TagSuggestion,
  type PageCrumb,
  type PageTitle,
  type VaultPath,
} from '@dfai/domain';
import { FavoriteStar } from './favorite-star.tsx';
import {
  NoteEditor,
  type HighlightLinks,
  type NoteHighlights,
  type NoteBookmarks,
  type NoteEditorHandle,
  type NotePeople,
  type NoteQueryBlocks,
  type NoteReveal,
  type NoteTransclusions,
} from './note-editor.tsx';
import type { EmbedImage } from './editor/image-uploads.ts';
import type { BlockPicking } from './editor/block-picking.ts';
import type { LinkedNoteMaker } from './editor/wiki-link-suggestion.ts';
import { NoteLinksPanel, type MentionsState } from './note-links.tsx';
import { LinkPicker } from './link-picker.tsx';
import { EditableTitle, HiddenTitle, PageHead } from './page-head.tsx';
import { PageBar, type PageHistory, type PageMenuItem } from './page-bar.tsx';
import type { RelatedPanel } from './related-notes.tsx';
import { TemplateBanner, type TemplateNotice } from './template-banner.tsx';
import { TrailBar, type TrailWalk } from './trail-bar.tsx';
import { MeetingCorrectionsBand, type CorrectionsNotice } from './meeting-corrections-band.tsx';
import { PromotionBanner, type LinePromotion } from './promotion-notice.tsx';
import { PropertiesStrip } from './peek/properties-strip.tsx';
import {
  PropertiesPanel,
  type NewProperty,
  type PropertyRow,
  type CreateRelated,
  type RelationChoice,
} from './properties-panel.tsx';
import type { RelationTarget } from './type-editor.tsx';
import type { OverlaySlots } from './overlay-slot.ts';
import { delayedSpinner } from './delayed-spinner.tsx';

export type NotePaneState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly title: string;
      readonly doc: EditorDocument;
      readonly dirty: boolean;
      readonly saving: boolean;
      readonly saveError: string | null;
    }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * How the open page is headed, worked out from the note by the rules in
 * `@dfai/domain` (`page/`): where it lives and its title.
 */
export interface PageHeading {
  /**
   * `note` is prose, read at a measure with its properties above it.
   * `view`, `dashboard` and `source` bring their own body — a source's card
   * already says what its frontmatter configures — and keep their frontmatter
   * behind "Page properties". `template` reads as a note does — its
   * properties and text are what it gives new notes — under a band saying so.
   */
  readonly kind: 'note' | 'view' | 'dashboard' | 'source' | 'template';
  readonly crumb: PageCrumb;
  readonly title: PageTitle;
  readonly description: string | null;
  /** The note's path in the vault, for "Reveal file path". */
  readonly path: string;
  /** The query behind a view, for "Show SQL"; null when there is none. */
  readonly sql: string | null;
}

/** The controls that arrange panes, which live in each page's bar. */
export interface PaneArrangement {
  /** Given only while a split is still possible. */
  readonly onSplit?: () => void;
  /** Given only while there is another pane to be left with. */
  readonly onClose?: () => void;
  /** Whether the split shortcut closes this pane, so its Close button can say so. */
  readonly closesFromShortcut?: boolean;
  /** Given on the first pane while the sidebar is hidden. */
  readonly onShowSidebar?: () => void;
  /** This pane's Back and Forward. */
  readonly history?: PageHistory;
  /** The "…" menu's open state, owned by the app's one-overlay rule. */
  readonly menuOpen?: boolean;
  readonly onMenuOpenChange?: (open: boolean) => void;
  /** The open state of the page's other popups — a widget's "…", Filter, Sort — held the same way. */
  readonly popups?: OverlaySlots;
}

export interface NotePaneProps {
  /**
   * What the page is drawn in. `page` (the default) heads it with its bar
   * and its properties block. `peek` leaves the bar to the peek's own
   * header and folds the properties into one strip under the title — the
   * same page, title and body, inside `PeekDialog`.
   */
  chrome?: 'page' | 'peek';
  state: NotePaneState;
  /** How the page is headed; null until the note has been read. */
  heading: PageHeading | null;
  arrangement: PaneArrangement;
  onChange: (doc: EditorDocument) => void;
  onSave: () => void;
  /** Opens the note a link names, at the heading or block it names when it does. */
  onFollowLink: (target: string, heading?: string | null, how?: OpenHow) => void;
  suggestNotes: (query: string) => NoteSuggestion[];
  /** Makes a note of a name typed after `[[` that no note has (#465). */
  onCreateNote?: LinkedNoteMaker;
  /** Tags offered after `#`; left out, none are. */
  suggestTags?: (query: string) => readonly TagSuggestion[];
  /** Opens the notes with a tag, when one in the note is clicked. */
  onOpenTag?: (name: string) => void;
  /** People offered after `@`, and links to them drawn as chips; left out, neither. */
  people?: NotePeople;
  /** Where bookmark cards read the notes they open; left out, each is drawn as its link. */
  bookmarks?: NoteBookmarks;
  /** Where shown blocks read the blocks they show; left out, each is drawn as its embed. */
  transclusions?: NoteTransclusions;
  /** A literature note's highlights that open in its reader ("Open in PDF", #506); left out, none offer it. */
  highlightLinks?: HighlightLinks | null;
  /** A literature note's highlights, drawn as quotes with comments to type in (#523); left out, as source. */
  highlights?: NoteHighlights | null;
  /** Where query blocks are answered, `this` being this note; left out, each is drawn as its code. */
  queries?: NoteQueryBlocks;
  /** A note's headings and blocks after `[[Note#`; left out, `#` offers nothing. */
  picking?: BlockPicking;
  /** Making a checklist line a task, and what the last try came to; left out, none is offered. */
  promotion?: LinePromotion;
  /** A block or heading of this note to bring into view: where a followed link pointed. */
  reveal?: NoteReveal | null;
  /**
   * Whether the right sidebar is showing this note's properties (UI v2 slice
   * 8b): a note's block then leaves the body rather than being drawn twice.
   * A view's "Page properties" item still reveals its block.
   */
  propertiesInAside?: boolean;
  /** What the note links to and what links to it, for its foot. */
  links: NoteLinks;
  /** Notes naming this one without a link, once they have been asked for. */
  mentions: MentionsState;
  onFindMentions: () => void;
  onLinkMention: (path: VaultPath) => void;
  /** Notes close in meaning and not linked yet, for its foot (P32-03); left out, none are offered. */
  related?: RelatedPanel;
  /** The trail the pane is walking, while it stands on this note (P32-03). */
  trail?: TrailWalk;
  onOpenNote: (path: VaultPath) => void;
  loadImage: (src: string) => Promise<string | null>;
  /** Saves an image pasted, dropped or picked into the note; left out where a page takes none. */
  embedImage?: EmbedImage;
  typeName: string | null;
  properties: readonly PropertyRow[];
  /**
   * Every key the note's frontmatter holds, including those no row shows, so
   * "Add a property" never writes an empty value over one of them.
   */
  propertyKeys: readonly string[];
  relationChoices: Readonly<Record<string, readonly RelationChoice[]>>;
  /** Makes a new note for a relation from its picker; left out, the picker offers only notes there are. */
  onCreateRelated?: CreateRelated;
  /** The note's type as a person reads it, which "Add a property" can add to. */
  typeLabel: string | null;
  /** The types a new relation can point at. */
  relationTargets: readonly RelationTarget[];
  /** Property values drawn by the caller, by key: an artifact's thumbnail as a picture. */
  customPropertyValues?: Readonly<Record<string, (id: string) => ReactNode>>;
  onChangeProperty: (key: string, value: unknown) => void;
  /** Adds a property to the note or its type; resolves with the key it is stored under. */
  onAddProperty: (property: NewProperty) => Promise<string>;
  onRename: (name: string) => void;
  /** Writes what is on screen over the file the save was refused against. */
  onOverwrite: () => void;
  /** Gives up the unsaved edits and takes the file instead. */
  onDiscard: () => void;
  favorite: boolean;
  onToggleFavorite: () => void;
  /** Drawn instead of the editor when the note is a view, a dashboard or a source. */
  body?: ReactNode;
  /** Drawn between the properties and the body: an artifact's saved copy. */
  aside?: ReactNode;
  /** A view's tabs and controls, drawn in the head under its title. */
  toolbar?: ReactNode;
  /** Opens the folder picker for this page; left out where it cannot be moved. */
  onMoveTo?: () => void;
  /** Asks which person to merge this one into (#464); given only on a person's page. */
  onMergeInto?: () => void;
  /** Asks to put this page in the Trash; left out where it cannot be deleted. */
  onDelete?: () => void;
  /** Puts this page in the Archive; left out where it cannot be archived. */
  onArchive?: () => void;
  /** Takes this page out of the Archive, back where it was; given only for an archived page. */
  onUnarchive?: () => void;
  /** The page's own actions, right of its title — a dashboard's Customize. */
  actions?: ReactNode;
  /** Opens the graph around this note; offered in the page's menu when given. */
  onShowInGraph?: () => void;
  /** Asks how to export this note (#501); offered in the page's menu when given. */
  onExport?: () => void;
  /** Given for a template: the band over it, saying what it is and what uses it. */
  template?: TemplateNotice;
  /** Given for a meeting whose spellings were corrected: the band over it, with its Undo. */
  corrections?: CorrectionsNotice;
}

/** A page: its bar across the top, then the note — or why there is no note yet. */
export function NotePane(props: NotePaneProps) {
  const { state, heading } = props;

  if (state.kind !== 'ready' || heading === null) {
    return (
      <>
        <PageBar
          crumb={null}
          name={null}
          menu={arrangeItems(props.arrangement)}
          {...barOverlay(props.arrangement)}
        />
        <div className="panel__body">
          <PaneMessage state={state} />
        </div>
      </>
    );
  }

  return <ReadyPage {...props} state={state} heading={heading} />;
}

function PaneMessage({ state }: { state: NotePaneState }) {
  if (state.kind === 'failed') {
    return (
      <p className="viewer viewer--error" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.kind === 'loading') return delayedSpinner('Reading the note…');
  return <p className="viewer viewer--muted">Select a note to read it.</p>;
}

type ReadyState = Extract<NotePaneState, { kind: 'ready' }>;

/** What the "…" menu has toggled on this page. Forgotten when another note opens. */
interface Revealed {
  readonly properties: boolean;
  readonly sql: boolean;
  readonly path: boolean;
  readonly renamingFile: boolean;
}

const NOTHING_REVEALED: Revealed = {
  properties: false,
  sql: false,
  path: false,
  renamingFile: false,
};

function ReadyPage(props: NotePaneProps & { state: ReadyState; heading: PageHeading }) {
  const { state, heading, arrangement } = props;
  const peek = props.chrome === 'peek';
  const [revealed, setRevealed] = useState(NOTHING_REVEALED);
  const [openedWithTitle] = useState(heading.title.source === 'property');
  const flip = (key: keyof Revealed) => setRevealed((was) => ({ ...was, [key]: !was[key] }));
  // A template is edited as the note it gives: properties above, text below.
  const isNote = heading.kind === 'note' || heading.kind === 'template';
  const editor = useRef<NoteEditorHandle>(null);
  const picker = usePickerSlot(arrangement);
  const pickImage = () => editor.current?.pickImage();
  // A view's description sits beside its name; a note's is one of its properties.
  const described =
    isNote || heading.description === null || heading.description.trim() === ''
      ? null
      : heading.description;

  return (
    <>
      {!peek && (
        <PageBar
          crumb={heading.crumb}
          name={heading.title.text}
          {...(!isNote && described !== null && { count: described })}
          {...(props.actions !== undefined && { actions: props.actions })}
          status={<SaveStatus state={state} />}
          // A template is never a favourite: the mark would be copied into every new note.
          star={
            props.template === undefined && (
              <FavoriteStar
                name={heading.title.text}
                favorite={props.favorite}
                onToggle={props.onToggleFavorite}
              />
            )
          }
          menu={[
            ...pageItems({ props, revealed, flip }),
            ...linkItems({ isNote, onLink: () => picker.setOpen(true), props }),
            // `pickImage` reads the ref only when the menu item is chosen, never while rendering.
            // eslint-disable-next-line react-hooks/refs
            ...imageItems({ isNote, props, onPick: pickImage }),
            ...arrangeItems(arrangement),
            ...fileItems(props),
          ]}
          {...barOverlay(arrangement)}
        />
      )}
      <SaveConflict state={state} onOverwrite={props.onOverwrite} onDiscard={props.onDiscard} />
      {props.template !== undefined && <TemplateBanner {...props.template} />}
      {props.corrections !== undefined && <MeetingCorrectionsBand {...props.corrections} />}
      <PromotionBanner notice={props.promotion?.notice ?? null} />
      {props.trail !== undefined && <TrailBar trail={props.trail} />}
      <div className={peek ? 'peek__page' : 'panel__body'}>
        {/* A view is a table or a board, not prose, so it is not held to a
            reading width — it uses the window it has been given. */}
        <article
          className={isNote ? 'page page--note' : 'page page--wide'}
          aria-label={heading.title.text}
        >
          {isNote || revealed.renamingFile ? (
            <PageHead
              title={
                <PageTitleEditor
                  {...props}
                  heading={heading}
                  renamingFile={revealed.renamingFile}
                  onRenamed={() => setRevealed((was) => ({ ...was, renamingFile: false }))}
                />
              }
            />
          ) : (
            <HiddenTitle>{heading.title.text}</HiddenTitle>
          )}
          {props.toolbar}
          {revealed.path && <p className="page__path">{heading.path}</p>}
          {revealed.sql && heading.sql !== null && <pre className="page__sql">{heading.sql}</pre>}
          {(isNote && props.propertiesInAside !== true) || revealed.properties ? (
            <PageProperties
              {...props}
              heading={heading}
              openedWithTitle={openedWithTitle}
              strip={peek && isNote}
            />
          ) : null}
          {props.aside}
          {props.body ?? (
            <NoteBody
              {...props}
              doc={state.doc}
              editor={editor}
              onRequestLink={() => picker.setOpen(true)}
            />
          )}
        </article>
      </div>
      {picker.open && (
        <LinkPicker
          suggestNotes={props.suggestNotes}
          onPick={(target) => {
            picker.setOpen(false);
            editor.current?.insertLink(target);
          }}
          onClose={() => picker.setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The note picker's open state: the app's, when it hands the page its popups,
 * so the picker obeys the one-overlay rule; otherwise the page's own.
 */
function usePickerSlot(arrangement: PaneArrangement) {
  const [ownOpen, setOwnOpen] = useState(false);
  const slot = arrangement.popups?.('link-picker');
  return slot === undefined
    ? { open: ownOpen, setOpen: setOwnOpen }
    : { open: slot.open, setOpen: slot.onOpenChange };
}

/** Linking from the menu, seeing the note among its links, and taking it out of the app. */
function linkItems({
  isNote,
  onLink,
  props,
}: {
  isNote: boolean;
  onLink: () => void;
  props: NotePaneProps;
}): PageMenuItem[] {
  const items: PageMenuItem[] = [];
  if (isNote) items.push({ label: 'Link to…', onSelect: onLink, movesFocus: true });
  if (props.onShowInGraph !== undefined) {
    items.push({ label: 'Show in graph', onSelect: props.onShowInGraph, movesFocus: true });
  }
  if (props.onExport !== undefined) {
    items.push({ label: 'Export…', onSelect: props.onExport, movesFocus: true });
  }
  return items;
}

/** Putting an image into the note, from the menu, when the note takes images. */
function imageItems({
  isNote,
  props,
  onPick,
}: {
  isNote: boolean;
  props: NotePaneProps;
  onPick: () => void;
}): PageMenuItem[] {
  if (!isNote || props.body !== undefined || props.embedImage === undefined) return [];
  return [{ label: 'Insert image…', onSelect: onPick }];
}

/** The title, edited where it came from: the `title` property, or the filename. */
function PageTitleEditor({
  heading,
  state,
  renamingFile,
  onRenamed,
  onRename,
  onChangeProperty,
}: NotePaneProps & {
  heading: PageHeading;
  state: ReadyState;
  renamingFile: boolean;
  onRenamed: () => void;
}) {
  if (renamingFile || heading.title.source === 'file') {
    return (
      <EditableTitle
        // A fresh field each time a rename is asked for from the menu.
        key={renamingFile ? 'renaming' : 'title'}
        value={state.title}
        label="Note name"
        hint="Rename this note"
        editing={renamingFile}
        onDone={onRenamed}
        onCommit={onRename}
      />
    );
  }
  return (
    <EditableTitle
      value={heading.title.text}
      label="Title"
      hint="Change the title"
      onCommit={(title) => onChangeProperty(TITLE_KEY, title)}
      // Clearing the title the file gave itself hands the heading back to the filename.
      onClear={() => onChangeProperty(TITLE_KEY, null)}
    />
  );
}

/**
 * The title row is hidden only on a page that opened headed by its `title`.
 * Deciding it per write instead would hide a title row the moment its first
 * keystroke made it the heading, and take the focus — and the rest of the
 * typing — with it.
 */
function PageProperties(
  props: NotePaneProps & { heading: PageHeading; openedWithTitle: boolean; strip: boolean },
) {
  const title = props.heading.title;
  const rows =
    props.openedWithTitle && title.source === 'property'
      ? props.properties.filter(
          (row) => !duplicatesTitle({ key: row.def.key, value: row.value, title: title.text }),
        )
      : props.properties;

  if (props.strip) {
    return (
      <PropertiesStrip
        path={props.heading.path}
        typeName={props.typeName}
        rows={rows}
        relationChoices={props.relationChoices}
        {...(props.customPropertyValues !== undefined && {
          customValues: props.customPropertyValues,
        })}
        onChange={props.onChangeProperty}
        onOpenNote={props.onOpenNote}
        {...(props.onCreateRelated !== undefined && { onCreateRelated: props.onCreateRelated })}
      />
    );
  }
  return (
    <PropertiesPanel
      typeName={props.typeName}
      rows={rows}
      relationChoices={props.relationChoices}
      typeLabel={props.typeLabel}
      relationTargets={props.relationTargets}
      {...(props.customPropertyValues !== undefined && {
        customValues: props.customPropertyValues,
      })}
      onChange={props.onChangeProperty}
      onAdd={props.onAddProperty}
      onOpenNote={props.onOpenNote}
      {...(props.onCreateRelated !== undefined && { onCreateRelated: props.onCreateRelated })}
      // A row hidden above (the title heading the page) is still in the file.
      fileKeys={[...props.propertyKeys, ...props.properties.map((row) => row.def.key)]}
    />
  );
}

/** Prose: the editor, then what it is linked with. */
function NoteBody({
  editor,
  ...props
}: NotePaneProps & {
  doc: EditorDocument;
  editor: RefObject<NoteEditorHandle | null>;
  onRequestLink: () => void;
}) {
  return (
    <>
      <div className="page__body">
        <NoteEditor
          ref={editor}
          doc={props.doc}
          onChange={props.onChange}
          onFollowLink={props.onFollowLink}
          suggestNotes={props.suggestNotes}
          {...(props.suggestTags !== undefined && { suggestTags: props.suggestTags })}
          {...(props.onOpenTag !== undefined && { onOpenTag: props.onOpenTag })}
          loadImage={props.loadImage}
          onRequestLink={props.onRequestLink}
          {...(props.embedImage !== undefined && { embedImage: props.embedImage })}
          {...(props.people !== undefined && { people: props.people })}
          {...(props.bookmarks !== undefined && { bookmarks: props.bookmarks })}
          {...(props.transclusions !== undefined && { transclusions: props.transclusions })}
          {...(props.queries !== undefined && { queries: props.queries })}
          highlightLinks={props.highlightLinks ?? null}
          highlights={props.highlights ?? null}
          {...(props.picking !== undefined && { picking: props.picking })}
          {...(props.promotion !== undefined && { onPromoteLine: props.promotion.promote })}
          {...(props.onCreateNote !== undefined && { onCreateNote: props.onCreateNote })}
          reveal={props.reveal ?? null}
        />
      </div>
      <NoteLinksPanel
        links={props.links}
        // A person's page lists the notes that link to them as where they are mentioned.
        incomingTitle={isPersonType(props.typeName) ? 'Mentioned in' : 'Links here'}
        onOpen={props.onOpenNote}
        mentions={props.mentions}
        onFindMentions={props.onFindMentions}
        onLinkMention={props.onLinkMention}
        {...(props.related !== undefined && { related: props.related })}
      />
    </>
  );
}

/**
 * The save state as a quiet word, where the Save button used to be: in a
 * page's bar, or the peek's header. Nothing before the note is read.
 */
export function SaveStatus({ state }: { state: NotePaneState }) {
  if (state.kind !== 'ready') return null;
  return <>{state.saving ? 'Saving…' : state.dirty ? 'Unsaved' : 'Saved'}</>;
}

/**
 * A refused save leaves the note unsavable until someone decides between the
 * two files, so the decision is offered at the top of the page rather than
 * left to be discovered by closing the pane.
 */
function SaveConflict({
  state,
  onOverwrite,
  onDiscard,
}: {
  state: ReadyState;
  onOverwrite: () => void;
  onDiscard: () => void;
}) {
  if (state.saveError === null) return null;
  return (
    <div className="page-conflict">
      <span className="page-conflict__message" role="alert">
        {state.saveError}
      </span>
      <button className="viewer__resolve" type="button" onClick={onOverwrite}>
        Overwrite the file
      </button>
      <button className="viewer__resolve" type="button" onClick={onDiscard}>
        Discard my changes
      </button>
    </div>
  );
}

/** The page's own commands, in the order they are reached for. */
function pageItems({
  props,
  revealed,
  flip,
}: {
  props: NotePaneProps & { state: ReadyState; heading: PageHeading };
  revealed: Revealed;
  flip: (key: keyof Revealed) => void;
}): PageMenuItem[] {
  const { state, heading } = props;
  const tucked = heading.kind !== 'note';
  const items: PageMenuItem[] = [
    {
      label: 'Save now',
      shortcut: '⌘S',
      onSelect: props.onSave,
      disabled: !state.dirty || state.saving,
    },
  ];
  if (heading.title.source === 'property') {
    items.push({ label: 'Rename file', onSelect: () => flip('renamingFile') });
  }
  if (tucked && props.properties.length > 0) {
    items.push({
      label: revealed.properties ? 'Hide page properties' : 'Page properties',
      onSelect: () => flip('properties'),
    });
  }
  if (heading.sql !== null) {
    items.push({ label: revealed.sql ? 'Hide SQL' : 'Show SQL', onSelect: () => flip('sql') });
  }
  items.push({
    label: revealed.path ? 'Hide file path' : 'Reveal file path',
    onSelect: () => flip('path'),
  });
  return items;
}

/**
 * Moving the page and throwing it away, last and set apart: a view or a
 * dashboard goes to the Trash from here, since it has no row in Pages to do it from.
 */
function fileItems({
  onMoveTo,
  onMergeInto,
  onDelete,
  onArchive,
  onUnarchive,
}: NotePaneProps): PageMenuItem[] {
  const items: PageMenuItem[] = [];
  if (onMoveTo !== undefined) {
    items.push({ label: 'Move to…', onSelect: onMoveTo, movesFocus: true });
  }
  if (onMergeInto !== undefined) {
    items.push({ label: 'Merge into…', onSelect: onMergeInto, movesFocus: true });
  }
  if (onArchive !== undefined) items.push({ label: 'Archive', onSelect: onArchive });
  if (onUnarchive !== undefined) items.push({ label: 'Unarchive', onSelect: onUnarchive });
  if (onDelete !== undefined) {
    items.push({ label: 'Delete…', onSelect: onDelete, movesFocus: true, destructive: true });
  }
  return items;
}

/**
 * Splitting and closing, which every pane offers whatever it holds — kept in
 * the menu, with its shortcut, beside the bar's own buttons for the same.
 */
function arrangeItems(arrangement: PaneArrangement): PageMenuItem[] {
  const items: PageMenuItem[] = [];
  if (arrangement.onSplit !== undefined) {
    items.push({
      label: 'Split right',
      shortcut: '⇧⌘\\',
      onSelect: arrangement.onSplit,
      movesFocus: true,
    });
  }
  if (arrangement.onClose !== undefined) {
    items.push({
      label: 'Close pane',
      shortcut: '⇧⌘\\',
      onSelect: arrangement.onClose,
      movesFocus: true,
    });
  }
  return items;
}

function barOverlay(arrangement: PaneArrangement) {
  return {
    ...(arrangement.menuOpen !== undefined && { menuOpen: arrangement.menuOpen }),
    ...(arrangement.onMenuOpenChange !== undefined && {
      onMenuOpenChange: arrangement.onMenuOpenChange,
    }),
    ...(arrangement.onShowSidebar !== undefined && { onShowSidebar: arrangement.onShowSidebar }),
    ...(arrangement.history !== undefined && { history: arrangement.history }),
    ...(arrangement.onSplit !== undefined && { onSplit: arrangement.onSplit }),
    ...(arrangement.onClose !== undefined && { onClose: arrangement.onClose }),
    ...(arrangement.closesFromShortcut !== undefined && {
      closesFromShortcut: arrangement.closesFromShortcut,
    }),
  };
}
