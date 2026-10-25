import type { BookRange, CfiPlace, ContentsEntry, PdfMetadata } from '@dfai/domain';

/*
 * What the EPUB reader's use-cases need of a book (#505): what it says about
 * itself, its contents, each chapter's text, and the translation between a
 * place in a chapter's text and the EPUB CFI that names it. foliate-js
 * answers it in the adapters; showing a chapter is the screen's, and not
 * asked here.
 */

/** An open EPUB. */
export interface EpubBook {
  /** How many chapters its spine has: each is a section of the book, from 0. */
  readonly sectionCount: number;
  /** Its title and first author, as its package says them. */
  readonly metadata: PdfMetadata;
  /** Its table of contents, each entry resolved to the chapter it goes to. */
  readonly contents: readonly ContentsEntry[];
  /** Section `section`'s text, as the reader lays the chapter out: every place in it is an offset of this. */
  sectionText(section: number): Promise<string>;
  /** Where `cfi` points in this book, or null when it names no chapter of it. */
  placeOfCfi(cfi: string): Promise<CfiPlace | null>;
  /** The EPUB CFI of `range`. */
  cfiOf(range: BookRange): Promise<string>;
  /** Lets the book go: nothing may be asked of it after. */
  close(): void;
}

/**
 * Lets the window's other work run. A read of every chapter of a book — find,
 * or a highlight looked for by its words — waits on it between chapters, so
 * a long book is read in many short tasks, not one that holds the window.
 */
export type YieldToHost = () => Promise<void>;

/** Opens EPUBs from their bytes. The bytes are the caller's still: they are not handed over. */
export interface EpubReaderPort {
  /**
   * Throws `EpubProtectedError` for a book locked with DRM, and
   * `EpubUnreadableError` for bytes that are not an EPUB it can read.
   */
  open(bytes: Uint8Array): Promise<EpubBook>;
}

/** Bytes the EPUB reader could not open: not an EPUB, or damaged. */
export class EpubUnreadableError extends Error {
  constructor(readonly reason: string) {
    super(`This EPUB could not be read: ${reason}`);
    this.name = 'EpubUnreadableError';
  }
}

/** A book whose chapters are locked with DRM: it can be neither read nor added. */
export class EpubProtectedError extends Error {
  constructor() {
    super('This EPUB is protected with DRM, so it cannot be opened.');
    this.name = 'EpubProtectedError';
  }
}
