import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  BOOK_FONT_DEFAULT,
  bookFontLabel,
  largerBookFont,
  sectionTitle,
  smallerBookFont,
  type BookRange,
  type ContentsEntry,
} from '@dfai/domain';
import { PageAction, PageBar, type PageHistory } from '../page-bar.tsx';
import { useBookAppearance, useShownSection, type Shown } from './book-frame.ts';
import { FindBar, useFind } from './find-bar.tsx';
import { HighlightsPanel } from './highlights-panel.tsx';
import { MarkPopover } from './mark-popover.tsx';
import { bookPanelEntries } from './panel-entries.ts';
import type {
  BookFrameEvents,
  BookMark,
  BookReaderActions,
  MarkRequest,
  ReaderBook,
  ReaderBookHighlight,
  ReaderReveal,
} from './reader-types.ts';

/*
 * The EPUB reader (#505): one chapter at a time in its frame, the text
 * reflowed at the size chosen and in the window's theme; the contents beside
 * it, find in the book, the chapters before and after, and the highlights
 * panel. Words selected in the chapter offer a highlight, an underline or a
 * comment, as the PDF reader's do. What each becomes is the caller's.
 */

export interface BookReaderProps extends BookReaderActions {
  readonly title: string;
  /** Where the file is: the breadcrumb's parent. */
  readonly folder: string;
  readonly book: ReaderBook;
  /** In the order they come in the book. */
  readonly highlights: readonly ReaderBookHighlight[];
  readonly reveal: ReaderReveal | null;
  /** What went wrong with the last thing asked, said over the text. */
  readonly notice: string | null;
  /** Null when the book has no literature note to keep highlights in: marking is then off. */
  readonly onOpenNote: (() => void) | null;
  readonly onShowSidebar?: () => void;
  readonly history?: PageHistory;
}

/** A place to bring into view once its chapter is on screen. */
type Pending = { readonly offset: number } | { readonly fragment: string | null };

export function BookReader(props: BookReaderProps) {
  const host = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState(0);
  const [fontSize, setFontSize] = useState(BOOK_FONT_DEFAULT);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  // A new object for every ask, so asking for a place in the chapter on screen brings it again.
  const [pending, setPending] = useState<{ section: number; place: Pending } | null>(null);
  const { flashing, flash } = useFlash();
  const goTo = useCallback(
    (place: { section: number } & Partial<{ offset: number; fragment: string | null }>) => {
      setPending({
        section: place.section,
        place:
          place.offset === undefined
            ? { fragment: place.fragment ?? null }
            : { offset: place.offset },
      });
      setSection(place.section);
      // A chapter that could not be shown says so until another is asked for.
      setFailure(null);
    },
    [],
  );
  const showMatch = useCallback(
    (match: BookRange) => goTo({ section: match.section, offset: match.start }),
    [goTo],
  );
  const find = useFind({ onSearch: props.onSearch, show: showMatch });
  const marking = useMarking({ props, host, section });
  const events = useFrameEvents({
    book: props.book,
    goTo,
    marking,
    onFind: find.toggle,
    findOpen: find.open,
  });
  const appearance = useBookAppearance(fontSize);
  const shown = useShownSection({
    book: props.book,
    section,
    host,
    appearance,
    events,
    onFailure: setFailure,
  });
  const { frameRef } = marking;
  useEffect(() => {
    frameRef.current = shown;
  }, [frameRef, shown]);
  usePlaceWhenShown({ shown, pending, done: () => setPending(null) });
  usePainting({ shown, highlights: props.highlights, flashing, find });
  const show = (id: string) => {
    const placement = props.highlights.find((highlight) => highlight.id === id)?.placement;
    if (placement !== undefined && placement.kind !== 'lost') {
      goTo({ section: placement.range.section, offset: placement.range.start });
    }
    flash(id);
  };
  useReveal({
    reveal: props.reveal,
    highlights: props.highlights,
    onReveal: (id) => {
      setPanelOpen(true);
      show(id);
    },
  });
  const entries = useMemo(
    () => bookPanelEntries(props.highlights, props.book.contents),
    [props.highlights, props.book.contents],
  );
  const chapter = sectionTitle({ section, contents: props.book.contents });
  const onSmaller = useCallback(() => setFontSize(smallerBookFont), []);
  const onLarger = useCallback(() => setFontSize(largerBookFont), []);
  const onContents = useCallback(() => setContentsOpen((was) => !was), []);
  const onPanel = useCallback(() => setPanelOpen((was) => !was), []);
  return (
    <>
      <PageBar
        crumb={{ icon: 'doc', parent: props.folder }}
        name={props.title}
        count={chapter}
        actions={
          <BookActionsBar
            fontSize={fontSize}
            onSmaller={onSmaller}
            onLarger={onLarger}
            contentsOpen={contentsOpen}
            onContents={onContents}
            findOpen={find.open}
            onFind={find.toggle}
            panelOpen={panelOpen}
            onPanel={onPanel}
            onOpenNote={props.onOpenNote}
          />
        }
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="pdf-reader epub-reader" onKeyDown={find.onKeyDown}>
        {contentsOpen && (
          <BookContents
            contents={props.book.contents}
            current={section}
            onGoTo={(to) => goTo({ section: to })}
          />
        )}
        <div className="pdf-reader__main">
          {find.open && <FindBar find={find} />}
          {(props.notice ?? failure) !== null && (
            <p className="notice pdf-reader__notice" role="alert">
              {props.notice ?? failure}
            </p>
          )}
          <div
            ref={host}
            className="epub-reader__page"
            // Which chapter is on screen and taking marks; absent while one is being shown.
            data-shown-section={shown?.section}
          >
            {marking.popover !== null && (
              <MarkPopover
                at={marking.popover.at}
                canUnderline
                onMark={marking.onMark}
                onDismiss={marking.dismiss}
              />
            )}
          </div>
          <ChapterTurns
            section={section}
            count={props.book.sectionCount}
            onGoTo={(to) => goTo({ section: to })}
          />
        </div>
        {panelOpen && (
          <HighlightsPanel
            entries={entries}
            emptyHint="Select words in the book to highlight them."
            flashing={flashing}
            onShow={show}
            onEditComment={props.onEditComment}
            onRemove={props.onRemove}
          />
        )}
      </div>
    </>
  );
}

const BookActionsBar = memo(function BookActionsBar({
  fontSize,
  onSmaller,
  onLarger,
  contentsOpen,
  onContents,
  findOpen,
  onFind,
  panelOpen,
  onPanel,
  onOpenNote,
}: {
  fontSize: number;
  onSmaller: () => void;
  onLarger: () => void;
  contentsOpen: boolean;
  onContents: () => void;
  findOpen: boolean;
  onFind: () => void;
  panelOpen: boolean;
  onPanel: () => void;
  onOpenNote: (() => void) | null;
}) {
  return (
    <>
      <PageAction icon="list" label="Contents" pressed={contentsOpen} onPress={onContents} />
      <PageAction icon="chevron-left" label="Smaller text" onPress={onSmaller} />
      <span className="pdf-reader__zoom" aria-live="polite">
        {bookFontLabel(fontSize)}
      </span>
      <PageAction icon="chevron-right" label="Larger text" onPress={onLarger} />
      <PageAction
        icon="search"
        label="Find"
        title="Find in book (⌘F)"
        pressed={findOpen}
        onPress={onFind}
      />
      <PageAction icon="panel" label="Highlights" pressed={panelOpen} onPress={onPanel} />
      {onOpenNote !== null && <PageAction icon="doc" label="Open note" onPress={onOpenNote} />}
    </>
  );
});

function BookContents({
  contents,
  current,
  onGoTo,
}: {
  contents: readonly ContentsEntry[];
  current: number;
  onGoTo: (section: number) => void;
}) {
  return (
    <nav className="pdf-side" aria-label="Contents">
      {contents.length === 0 ? (
        <p className="pdf-side__empty">This book has no table of contents.</p>
      ) : (
        <ContentsLevel entries={contents} current={current} onGoTo={onGoTo} />
      )}
    </nav>
  );
}

function ContentsLevel({
  entries,
  current,
  onGoTo,
}: {
  entries: readonly ContentsEntry[];
  current: number;
  onGoTo: (section: number) => void;
}) {
  return (
    <ul className="pdf-outline">
      {entries.map((entry, at) => (
        <li key={`${at}-${entry.title}`}>
          <button
            type="button"
            className="pdf-outline__entry"
            disabled={entry.section === null}
            aria-current={entry.section === current ? 'true' : undefined}
            onClick={() => entry.section !== null && onGoTo(entry.section)}
          >
            <span className="pdf-outline__title">{entry.title || 'Untitled'}</span>
          </button>
          {entry.children.length > 0 && (
            <ContentsLevel entries={entry.children} current={current} onGoTo={onGoTo} />
          )}
        </li>
      ))}
    </ul>
  );
}

function ChapterTurns({
  section,
  count,
  onGoTo,
}: {
  section: number;
  count: number;
  onGoTo: (section: number) => void;
}) {
  return (
    <nav className="epub-reader__turns" aria-label="Chapters">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={section === 0}
        onClick={() => onGoTo(section - 1)}
      >
        Previous chapter
      </button>
      <span className="epub-reader__where">
        {section + 1} of {count}
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={section >= count - 1}
        onClick={() => onGoTo(section + 1)}
      >
        Next chapter
      </button>
    </nav>
  );
}

/** What the frame's links and keys do: a link of the book goes to its chapter, ⌘F opens find. */
function useFrameEvents({
  book,
  goTo,
  marking,
  onFind,
  findOpen,
}: {
  book: ReaderBook;
  goTo: (place: { section: number; fragment: string | null }) => void;
  marking: ReturnType<typeof useMarking>;
  onFind: () => void;
  findOpen: boolean;
}): BookFrameEvents {
  return {
    onLink: ({ path, fragment }) => {
      const section = book.sectionOfPath(path);
      if (section !== null) goTo({ section, fragment });
    },
    onSelectionEnd: marking.onSelectionEnd,
    onKeyDown: (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (!findOpen) onFind();
      }
    },
    onScroll: marking.follow,
  };
}

/** Brings the place asked for into view once its chapter is on screen. */
function usePlaceWhenShown({
  shown,
  pending,
  done,
}: {
  shown: Shown | null;
  pending: { section: number; place: Pending } | null;
  done: () => void;
}) {
  const latest = useRef(done);
  useEffect(() => {
    latest.current = done;
  });
  useEffect(() => {
    if (shown === null || pending === null || pending.section !== shown.section) return;
    if ('offset' in pending.place) shown.frame.scrollToOffset(pending.place.offset);
    else shown.frame.scrollToFragment(pending.place.fragment);
    latest.current();
  }, [shown, pending]);
}

/** Draws the chapter's highlights, the one asked for lit, and find's matches in it. */
function usePainting({
  shown,
  highlights,
  flashing,
  find,
}: {
  shown: Shown | null;
  highlights: readonly ReaderBookHighlight[];
  flashing: string | null;
  find: { readonly matches: readonly BookRange[]; readonly currentMatch: BookRange | null };
}) {
  useEffect(() => {
    if (shown === null) return;
    shown.frame.paint(marksIn(highlights, shown.section), flashing);
  }, [shown, highlights, flashing]);
  useEffect(() => {
    if (shown === null) return;
    const here = find.matches.filter((match) => match.section === shown.section);
    const current = find.currentMatch === null ? -1 : here.indexOf(find.currentMatch);
    shown.frame.paintFound(here, current === -1 ? null : current);
  }, [shown, find.matches, find.currentMatch]);
}

function marksIn(highlights: readonly ReaderBookHighlight[], section: number): BookMark[] {
  return highlights.flatMap((highlight) => {
    const { placement } = highlight;
    if (placement.kind === 'lost' || placement.range.section !== section) return [];
    return [
      {
        id: highlight.id,
        start: placement.range.start,
        end: placement.range.end,
        style: highlight.style,
      },
    ];
  });
}

/** How long a highlight stays lit after it is brought into view. */
const FLASH_MS = 1600;

function useFlash() {
  const [flashing, setFlashing] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback((id: string) => {
    if (timer.current !== null) clearTimeout(timer.current);
    setFlashing(id);
    timer.current = setTimeout(() => setFlashing(null), FLASH_MS);
  }, []);
  return { flashing, flash };
}

/** Shows the highlight asked for, once per ask, as soon as it is among the highlights placed. */
function useReveal({
  reveal,
  highlights,
  onReveal,
}: {
  reveal: ReaderReveal | null;
  highlights: readonly ReaderBookHighlight[];
  onReveal: (id: string) => void;
}) {
  const handled = useRef<number | null>(null);
  const latest = useRef(onReveal);
  useEffect(() => {
    latest.current = onReveal;
  });
  useEffect(() => {
    // A book has no pages: `[[book.epub#page=3]]` asks for nothing it can show.
    if (reveal === null || handled.current === reveal.key || !('id' in reveal)) return;
    if (!highlights.some((highlight) => highlight.id === reveal.id)) return;
    handled.current = reveal.key;
    latest.current(reveal.id);
  }, [reveal, highlights]);
}

interface Popover {
  readonly at: { left: number; top: number };
  readonly selection: BookRange;
}

/** The popover a selection in the chapter offers, and what pressing it does. */
function useMarking({
  props,
  host,
  section,
}: {
  props: BookReaderProps;
  host: RefObject<HTMLDivElement | null>;
  section: number;
}) {
  const [popover, setPopover] = useState<Popover | null>(null);
  const frameRef = useRef<Shown | null>(null);
  const canMark = props.onOpenNote !== null;
  const where = (rect: DOMRect) => {
    const box = host.current?.getBoundingClientRect();
    return {
      left: Math.max(8, rect.left - (box?.left ?? 0)),
      top: Math.max(8, rect.top - (box?.top ?? 0) - 44),
    };
  };
  const selected = () => frameRef.current?.frame.selection() ?? null;
  const onSelectionEnd = () => {
    const picked = canMark ? selected() : null;
    const shown = frameRef.current;
    if (picked === null || shown === null) return;
    const range = { section: shown.section, start: picked.start, end: picked.end };
    setPopover({ at: where(picked.rect), selection: range });
  };
  // The frame scrolls on its own: the popover keeps to the words it is for.
  const follow = () => {
    const picked = selected();
    if (picked !== null)
      setPopover((was) => (was === null ? was : { ...was, at: where(picked.rect) }));
  };
  const dismiss = () => setPopover(null);
  const onMark = async (request: MarkRequest) => {
    const asked = popover;
    if (asked === null) return;
    const finish = () => {
      setPopover(null);
      frameRef.current?.frame.clearSelection();
    };
    // Colours and underlines hold nothing to lose: gone at once, a refusal said by the container's notice.
    if (request.comment === undefined) finish();
    const taken = await props.onHighlight({ ...request, selection: asked.selection });
    // A comment is the person's own words: the popover keeps them until the note has taken them.
    if (taken) finish();
  };
  // A selection belongs to the chapter it was made in: another chapter on screen shows none.
  const shown = popover?.selection.section === section ? popover : null;
  return { popover: shown, onSelectionEnd, follow, dismiss, onMark, frameRef };
}
