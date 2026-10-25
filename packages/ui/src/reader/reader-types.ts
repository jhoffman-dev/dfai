import type {
  BookPlacement,
  BookRange,
  ContentsEntry,
  DocumentMatch,
  HighlightColor,
  HighlightPlacement,
  HighlightStyle,
  PageRect,
  PdfPageText,
  TextSelection,
} from '@dfai/domain';

/*
 * What the PDF reader is handed (#504): a document it can ask for pages,
 * the highlights already placed on it, and what to call when the person
 * marks something. It draws; every rule is the caller's.
 */

/** A page's size in PDF points. */
export interface ReaderPageSize {
  readonly width: number;
  readonly height: number;
}

/** A page being drawn: wait for it, or stop it. */
export interface ReaderDrawing {
  readonly done: Promise<void>;
  cancel(): void;
}

/** The open PDF, as the reader draws it. */
export interface ReaderDocument {
  readonly pageCount: number;
  pageSize(page: number): Promise<ReaderPageSize>;
  pageText(page: number): Promise<PdfPageText>;
  drawPage(args: { page: number; canvas: HTMLCanvasElement; scale: number }): ReaderDrawing;
}

export interface ReaderOutlineEntry {
  readonly title: string;
  readonly page: number | null;
  readonly children: readonly ReaderOutlineEntry[];
}

/** A highlight of the document, and where it is drawn. */
export interface ReaderHighlight {
  readonly id: string;
  /** Its words as the note shows them; empty for an area. */
  readonly quote: string;
  readonly comment: string;
  readonly style: HighlightStyle;
  readonly placement: HighlightPlacement;
}

/**
 * A highlight to bring into view and flash, or a page to bring into view
 * (`[[file.pdf#page=3]]`); `key` changes for each ask, so asking twice acts
 * twice.
 */
export type ReaderReveal =
  { readonly id: string; readonly key: number } | { readonly page: number; readonly key: number };

/** What the person marked, and how. */
export interface MarkRequest {
  readonly style: HighlightStyle;
  readonly comment?: string;
}

/**
 * What the reader asks the note to do. A write answers whether the note took
 * it: false is a write refused (and said by the reader's notice), so a form
 * holding the person's words stays open for them to try again.
 */
export interface ReaderActions {
  onHighlight(request: MarkRequest & { selection: TextSelection }): Promise<boolean>;
  onHighlightArea(request: MarkRequest & { page: number; box: PageRect }): Promise<boolean>;
  onEditComment(request: { id: string; comment: string }): Promise<boolean>;
  onRemove(id: string): Promise<boolean>;
  onSearch(phrase: string): Promise<{ matches: readonly DocumentMatch[]; more: boolean }>;
}

/*
 * What the EPUB reader is handed (#505): a book it can ask to show a chapter
 * in a frame of its own, the highlights already placed in it, and what to
 * call when the person marks something. It lays the reader out; the frame,
 * and every rule, are the caller's.
 */

/** How the book looks in its frame: the size chosen, and the theme's colours. */
export interface BookAppearance {
  /** The text's size, as a percentage of the book's own. */
  readonly fontSize: number;
  readonly scheme: 'light' | 'dark';
  readonly ink: string;
  readonly page: string;
  readonly link: string;
  readonly marks: Readonly<
    Record<HighlightColor, { readonly fill: string; readonly line: string }>
  >;
  readonly markInk: string;
  readonly flash: string;
  readonly found: string;
  readonly foundCurrent: string;
}

/** A highlight drawn in the chapter on screen: `[start, end)` of its text. */
export interface BookMark {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly style: HighlightStyle;
}

/** What the person does in the chapter's frame. */
export interface BookFrameEvents {
  onLink(target: { path: string; fragment: string | null }): void;
  onSelectionEnd(): void;
  onKeyDown(event: KeyboardEvent): void;
  onScroll(): void;
}

/** A chapter on screen. */
export interface ShownBookSection {
  selection(): { start: number; end: number; rect: DOMRect } | null;
  clearSelection(): void;
  paint(marks: readonly BookMark[], flashing: string | null): void;
  paintFound(found: readonly { start: number; end: number }[], current: number | null): void;
  scrollToOffset(offset: number): void;
  scrollToFragment(fragment: string | null): void;
  setAppearance(appearance: BookAppearance): void;
  destroy(): void;
}

/** The open book, as the reader shows it. */
export interface ReaderBook {
  readonly sectionCount: number;
  readonly contents: readonly ContentsEntry[];
  /** The chapter the book's file at `path` is, for a link inside the book; null when it is none. */
  sectionOfPath(path: string): number | null;
  show(args: {
    section: number;
    host: HTMLElement;
    appearance: BookAppearance;
    events: BookFrameEvents;
  }): Promise<ShownBookSection>;
}

/** A highlight of the book, and where it is drawn. */
export interface ReaderBookHighlight {
  readonly id: string;
  readonly quote: string;
  readonly comment: string;
  readonly style: HighlightStyle;
  readonly placement: BookPlacement;
}

/** What the book reader asks the note to do; a write answers whether the note took it. */
export interface BookReaderActions {
  onHighlight(request: MarkRequest & { selection: BookRange }): Promise<boolean>;
  onEditComment(request: { id: string; comment: string }): Promise<boolean>;
  onRemove(id: string): Promise<boolean>;
  onSearch(phrase: string): Promise<{ matches: readonly BookRange[]; more: boolean }>;
}
