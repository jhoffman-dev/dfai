import { useEffect, useRef } from 'react';
import type { ReaderDocument, ReaderOutlineEntry, ReaderPageSize } from './reader-types.ts';
import { useRangeVirtualizer } from '../range-virtualizer.ts';

/*
 * The reader's side: the PDF's outline, or its pages as small pictures, to
 * go to a place. The pictures are drawn only for the pages in view, so a
 * long PDF costs no more than a short one.
 */

export type SidebarTab = 'outline' | 'pages';

export interface ReaderSidebarProps {
  readonly pdf: ReaderDocument;
  readonly outline: readonly ReaderOutlineEntry[] | null;
  readonly estimate: ReaderPageSize;
  readonly tab: SidebarTab;
  readonly currentPage: number;
  readonly onTab: (tab: SidebarTab) => void;
  readonly onGoTo: (page: number) => void;
}

export function ReaderSidebar(props: ReaderSidebarProps) {
  return (
    <nav className="pdf-side" aria-label="Document">
      <div className="pdf-side__tabs" role="tablist">
        {(['outline', 'pages'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={props.tab === tab}
            className="pdf-side__tab"
            onClick={() => props.onTab(tab)}
          >
            {tab === 'outline' ? 'Outline' : 'Pages'}
          </button>
        ))}
      </div>
      {props.tab === 'outline' ? (
        <Outline outline={props.outline} onGoTo={props.onGoTo} />
      ) : (
        <Thumbnails {...props} />
      )}
    </nav>
  );
}

function Outline({
  outline,
  onGoTo,
}: {
  outline: readonly ReaderOutlineEntry[] | null;
  onGoTo: (page: number) => void;
}) {
  if (outline === null) return <p className="pdf-side__empty">Reading the outline…</p>;
  if (outline.length === 0) return <p className="pdf-side__empty">This PDF has no outline.</p>;
  return <OutlineLevel entries={outline} onGoTo={onGoTo} />;
}

function OutlineLevel({
  entries,
  onGoTo,
}: {
  entries: readonly ReaderOutlineEntry[];
  onGoTo: (page: number) => void;
}) {
  return (
    <ul className="pdf-outline">
      {entries.map((entry, at) => (
        <li key={`${at}-${entry.title}`}>
          <button
            type="button"
            className="pdf-outline__entry"
            disabled={entry.page === null}
            onClick={() => entry.page !== null && onGoTo(entry.page)}
          >
            <span className="pdf-outline__title">{entry.title}</span>
            {entry.page !== null && <span className="pdf-outline__page">{entry.page}</span>}
          </button>
          {entry.children.length > 0 && <OutlineLevel entries={entry.children} onGoTo={onGoTo} />}
        </li>
      ))}
    </ul>
  );
}

const THUMB_WIDTH = 112;
const THUMB_GAP = 28;

function Thumbnails({ pdf, estimate, currentPage, onGoTo }: ReaderSidebarProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const height = (estimate.height / estimate.width) * THUMB_WIDTH;
  const rows = useRangeVirtualizer({
    count: pdf.pageCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => height + THUMB_GAP,
    overscan: 3,
  });
  return (
    <div ref={scroller} className="pdf-thumbs">
      <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
        {rows.getVirtualItems().map((row) => (
          <button
            key={row.key}
            type="button"
            className="pdf-thumb"
            aria-label={`Go to page ${row.index + 1}`}
            aria-current={row.index + 1 === currentPage ? 'page' : undefined}
            style={{ transform: `translateY(${row.start}px)` }}
            onClick={() => onGoTo(row.index + 1)}
          >
            <Thumbnail
              pdf={pdf}
              page={row.index + 1}
              width={THUMB_WIDTH}
              height={height}
              pageWidth={estimate.width}
            />
            <span className="pdf-thumb__number">{row.index + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Thumbnail({
  pdf,
  page,
  width,
  height,
  pageWidth,
}: {
  pdf: ReaderDocument;
  page: number;
  width: number;
  height: number;
  /** The page's width in points, so the picture is drawn at the size it is shown. */
  pageWidth: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (target === null) return;
    const drawing = pdf.drawPage({
      page,
      canvas: target,
      scale: (width / pageWidth) * (globalThis.devicePixelRatio || 1),
    });
    drawing.done.catch(
      // A picture that could not be drawn leaves the blank page with its number: still a way there.
      () => undefined,
    );
    return () => drawing.cancel();
  }, [pdf, page, width, pageWidth]);
  return <canvas ref={canvas} className="pdf-thumb__canvas" style={{ width, height }} />;
}
