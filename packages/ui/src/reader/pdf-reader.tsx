import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import {
  draggedBox,
  fitWidthZoom,
  zoomIn,
  zoomLabel,
  zoomOut,
  type DocumentMatch,
  type PageRect,
  type PagePoint,
  type TextSelection,
} from '@dfai/domain';
import { PageAction, PageBar, type PageHistory } from '../page-bar.tsx';
import { FindBar, useFind } from './find-bar.tsx';
import { HighlightsPanel } from './highlights-panel.tsx';
import { MarkPopover } from './mark-popover.tsx';
import { pdfPanelEntries } from './panel-entries.ts';
import { PdfPage } from './pdf-page.tsx';
import { ReaderSidebar, type SidebarTab } from './reader-sidebar.tsx';
import type {
  MarkRequest,
  ReaderActions,
  ReaderDocument,
  ReaderHighlight,
  ReaderOutlineEntry,
  ReaderPageSize,
  ReaderReveal,
} from './reader-types.ts';
import { selectionInPage } from './text-selection.ts';

/*
 * The PDF reader (#504): the document's pages one under another, drawn only
 * near the screen so a 500-page PDF is as quick as a short one; zoom, find,
 * the outline and page pictures beside it, and the highlights panel. Words
 * selected on a page, or a box dragged on a scanned one, offer a highlight,
 * an underline or a comment. What each becomes is the caller's to decide.
 */

export interface PdfReaderProps extends ReaderActions {
  readonly title: string;
  /** Where the file is: the breadcrumb's parent. */
  readonly folder: string;
  readonly pdf: ReaderDocument;
  /** The first page's size, which every page has until its own is read. */
  readonly firstPageSize: ReaderPageSize;
  readonly outline: readonly ReaderOutlineEntry[] | null;
  /** In reading order. */
  readonly highlights: readonly ReaderHighlight[];
  readonly reveal: ReaderReveal | null;
  /** What went wrong with the last thing asked, said over the pages. */
  readonly notice: string | null;
  /** Null when the PDF has no literature note to keep highlights in: marking is then off. */
  readonly onOpenNote: (() => void) | null;
  readonly onShowSidebar?: () => void;
  readonly history?: PageHistory;
}

/** The room between pages, and above the first. */
const PAGE_GAP = 16;

export function PdfReader(props: PdfReaderProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [side, setSide] = useState<SidebarTab | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const pages = usePages({
    scroller,
    count: props.pdf.pageCount,
    size: props.firstPageSize,
    zoom,
  });
  const { flashing, flash } = useFlash();
  const goTo = useGoTo({ pages, size: props.firstPageSize, zoom });
  const showMatch = useCallback((match: DocumentMatch) => goTo(match.page, match.rects[0]), [goTo]);
  const find = useFind({ onSearch: props.onSearch, show: showMatch });
  const marking = useMarking({ props, scroller });
  // Stable, so the bar of buttons is drawn again only when what it shows changes.
  const pageWidth = props.firstPageSize.width;
  const onFit = useCallback(
    () => setZoom(fitWidthZoom({ available: scroller.current?.clientWidth ?? 0, pageWidth })),
    [pageWidth],
  );
  const onSide = useCallback(() => setSide((was) => (was === null ? 'outline' : null)), []);
  const onPanel = useCallback(() => setPanelOpen((was) => !was), []);
  const entries = useMemo(() => pdfPanelEntries(props.highlights), [props.highlights]);
  const show = (id: string) => {
    const placement = props.highlights.find((highlight) => highlight.id === id)?.placement;
    if (placement !== undefined && placement.kind !== 'lost')
      goTo(placement.page, placement.rects[0]);
    flash(id);
  };
  useReveal({
    reveal: props.reveal,
    highlights: props.highlights,
    onReveal: (id) => {
      setPanelOpen(true);
      show(id);
    },
    onPage: (page) => goTo(page),
  });
  return (
    <>
      <PageBar
        crumb={{ icon: 'doc', parent: props.folder }}
        name={props.title}
        count={`${props.pdf.pageCount} ${props.pdf.pageCount === 1 ? 'page' : 'pages'}`}
        actions={
          <ReaderActionsBar
            zoom={zoom}
            onZoom={setZoom}
            onFit={onFit}
            findOpen={find.open}
            onFind={find.toggle}
            side={side}
            onSide={onSide}
            panelOpen={panelOpen}
            onPanel={onPanel}
            onOpenNote={props.onOpenNote}
          />
        }
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="pdf-reader" onKeyDown={find.onKeyDown}>
        {side !== null && (
          <ReaderSidebar
            pdf={props.pdf}
            outline={props.outline}
            estimate={props.firstPageSize}
            tab={side}
            currentPage={currentPage(pages)}
            onTab={setSide}
            onGoTo={(page) => goTo(page)}
          />
        )}
        <div className="pdf-reader__main">
          {find.open && <FindBar find={find} />}
          {props.notice !== null && (
            <p className="notice pdf-reader__notice" role="alert">
              {props.notice}
            </p>
          )}
          <div
            ref={scroller}
            className="pdf-reader__pages"
            tabIndex={-1}
            onMouseUp={marking.onSelectionEnd}
            onKeyUp={marking.onSelectionEnd}
          >
            <div style={{ height: pages.getTotalSize(), position: 'relative' }}>
              {pages.getVirtualItems().map((row) => (
                <div
                  key={row.key}
                  className="pdf-reader__slot"
                  style={{ transform: `translateY(${row.start + PAGE_GAP}px)` }}
                >
                  <PdfPage
                    pdf={props.pdf}
                    page={row.index + 1}
                    zoom={zoom}
                    estimate={props.firstPageSize}
                    highlights={props.highlights}
                    matches={find.matches}
                    currentMatch={find.currentMatch}
                    flashing={flashing}
                    onAreaDrawn={marking.onAreaDrawn}
                  />
                </div>
              ))}
            </div>
            {marking.popover !== null && (
              <MarkPopover
                at={marking.popover.at}
                canUnderline={marking.popover.kind === 'words'}
                onMark={marking.onMark}
                onDismiss={marking.dismiss}
              />
            )}
          </div>
        </div>
        {panelOpen && (
          <HighlightsPanel
            entries={entries}
            emptyHint="Select words on a page to highlight them."
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

const ReaderActionsBar = memo(function ReaderActionsBar({
  zoom,
  onZoom,
  onFit,
  findOpen,
  onFind,
  side,
  onSide,
  panelOpen,
  onPanel,
  onOpenNote,
}: {
  zoom: number;
  onZoom: (zoom: number) => void;
  onFit: () => void;
  findOpen: boolean;
  onFind: () => void;
  side: SidebarTab | null;
  onSide: () => void;
  panelOpen: boolean;
  onPanel: () => void;
  onOpenNote: (() => void) | null;
}) {
  return (
    <>
      <PageAction icon="list" label="Outline" pressed={side !== null} onPress={onSide} />
      <PageAction icon="chevron-left" label="Zoom out" onPress={() => onZoom(zoomOut(zoom))} />
      <span className="pdf-reader__zoom" aria-live="polite">
        {zoomLabel(zoom)}
      </span>
      <PageAction icon="chevron-right" label="Zoom in" onPress={() => onZoom(zoomIn(zoom))} />
      <PageAction icon="split" label="Fit width" onPress={onFit} />
      <PageAction
        icon="search"
        label="Find"
        title="Find in document (⌘F)"
        pressed={findOpen}
        onPress={onFind}
      />
      <PageAction icon="panel" label="Highlights" pressed={panelOpen} onPress={onPanel} />
      {onOpenNote !== null && <PageAction icon="doc" label="Open note" onPress={onOpenNote} />}
    </>
  );
});

function usePages({
  scroller,
  count,
  size,
  zoom,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  count: number;
  size: ReaderPageSize;
  zoom: number;
}) {
  const pages = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => size.height * zoom + PAGE_GAP,
    overscan: 2,
  });
  // Every page is a new height at a new zoom.
  useEffect(() => pages.measure(), [pages, zoom]);
  return pages;
}

type Pages = Virtualizer<HTMLDivElement, Element>;

/** The page most of the screen shows, from 1. */
function currentPage(pages: Pages): number {
  const offset = pages.scrollOffset ?? 0;
  const items = pages.getVirtualItems();
  const shown = items.find((item) => item.end > offset + 40) ?? items[0];
  return (shown?.index ?? 0) + 1;
}

/** Brings page `page` into view, at `rect` on it when given. */
function useGoTo({ pages, size, zoom }: { pages: Pages; size: ReaderPageSize; zoom: number }) {
  return useCallback(
    (page: number, rect?: PageRect) => {
      const index = Math.min(Math.max(page - 1, 0), pages.options.count - 1);
      const [start] = pages.getOffsetForIndex(index, 'start') ?? [0];
      const within = rect === undefined ? 0 : rect.y * size.height * zoom - 80;
      pages.scrollToOffset(Math.max(0, start + Math.max(0, within)));
    },
    [pages, size.height, zoom],
  );
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

/**
 * Shows the highlight asked for, once per ask, as soon as it is among the
 * highlights placed; or the page asked for, as soon as it is asked.
 */
function useReveal({
  reveal,
  highlights,
  onReveal,
  onPage,
}: {
  reveal: ReaderReveal | null;
  highlights: readonly ReaderHighlight[];
  onReveal: (id: string) => void;
  onPage: (page: number) => void;
}) {
  const handled = useRef<number | null>(null);
  const latest = useRef({ onReveal, onPage });
  useEffect(() => {
    latest.current = { onReveal, onPage };
  });
  useEffect(() => {
    if (reveal === null || handled.current === reveal.key) return;
    if ('page' in reveal) {
      handled.current = reveal.key;
      latest.current.onPage(reveal.page);
      return;
    }
    if (!highlights.some((highlight) => highlight.id === reveal.id)) return;
    handled.current = reveal.key;
    latest.current.onReveal(reveal.id);
  }, [reveal, highlights]);
}

type Popover =
  | { kind: 'words'; at: { left: number; top: number }; selection: TextSelection }
  | { kind: 'area'; at: { left: number; top: number }; page: number; box: PageRect };

/** The popover a selection or a dragged box offers, and what pressing it does. */
function useMarking({
  props,
  scroller,
}: {
  props: PdfReaderProps;
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const [popover, setPopover] = useState<Popover | null>(null);
  const canMark = props.onOpenNote !== null;
  const where = useCallback(
    (rect: DOMRect) => {
      const frame = scroller.current?.getBoundingClientRect();
      const top = (scroller.current?.scrollTop ?? 0) + rect.top - (frame?.top ?? 0) - 44;
      return { left: Math.max(8, rect.left - (frame?.left ?? 0)), top: Math.max(8, top) };
    },
    [scroller],
  );
  const onSelectionEnd = () => {
    if (!canMark) return;
    const selected = globalThis.getSelection?.() ?? null;
    const selection = selectionInPage(selected);
    if (selection === null || selected === null) return;
    setPopover({
      kind: 'words',
      at: where(selected.getRangeAt(0).getBoundingClientRect()),
      selection,
    });
  };
  // Stable: every page holds it, and a page is drawn again when it changes.
  const onAreaDrawn = useCallback(
    ({ page, from, to, at }: { page: number; from: PagePoint; to: PagePoint; at: DOMRect }) => {
      const box = canMark ? draggedBox(from, to) : null;
      if (box === null) return;
      const top = at.top + box.y * at.height;
      setPopover({
        kind: 'area',
        at: where(new DOMRect(at.left + box.x * at.width, top, 0, 0)),
        page,
        box,
      });
    },
    [canMark, where],
  );
  const dismiss = () => setPopover(null);
  const onMark = async (request: MarkRequest) => {
    const asked = popover;
    if (asked === null) return;
    const finish = () => {
      setPopover(null);
      globalThis.getSelection?.()?.removeAllRanges();
    };
    // Colours and underlines hold nothing to lose: gone at once, a refusal said by the container's notice.
    if (request.comment === undefined) finish();
    const taken = await (asked.kind === 'words'
      ? props.onHighlight({ ...request, selection: asked.selection })
      : props.onHighlightArea({ ...request, page: asked.page, box: asked.box }));
    // A comment is the person's own words: the popover keeps them until the note has taken them.
    if (taken) finish();
  };
  return { popover, onSelectionEnd, onAreaDrawn, dismiss, onMark };
}
