/*
 * The readers' rules: the PDF reader's (#504) — a page's words and where
 * they sit, what a selection or a dragged box becomes, where a stored
 * highlight is drawn, find in a document, zoom, and what adding a PDF to the
 * library names — and the EPUB reader's (#505): what a book may load, what a
 * selection in a chapter becomes, where a stored highlight is drawn, and
 * which books can be opened at all. All pure; pdf.js and foliate-js are the
 * adapters' and the screen is the UI's.
 */
export {
  EMPTY_PAGE_TEXT,
  hasWords,
  onPage,
  pdfPageText,
  rectsForRange,
  textOffsetNear,
} from './pdf-page-text.ts';
export type {
  PageVector,
  PdfPageText,
  PdfTextRun,
  PlacedTextRun,
  RunDirection,
} from './pdf-page-text.ts';
export {
  areaHighlight,
  draggedBox,
  SMALLEST_AREA,
  textHighlight,
  trimmedSelection,
} from './pdf-selection.ts';
export type { PagePoint, TextSelection } from './pdf-selection.ts';
export {
  inReadingOrder,
  isExact,
  placeByBoxes,
  placeByWords,
  placeOnItsPage,
} from './placement.ts';
export type { DrawnPlacement, HighlightPlacement } from './placement.ts';
export { findInDocument, findInTexts, MOST_MATCHES, stepMatch } from './find-in-document.ts';
export type { DocumentMatch, TextMatch } from './find-in-document.ts';
export {
  clampZoom,
  fitWidthZoom,
  LARGEST_ZOOM,
  SMALLEST_ZOOM,
  ZOOM_STEPS,
  zoomIn,
  zoomLabel,
  zoomOut,
} from './zoom.ts';
export {
  areaImageName,
  checkIncomingDocument,
  isPdfName,
  libraryFileName,
  libraryFolder,
  literatureDetails,
  literatureNoteFileName,
  looksLikePdf,
  MAX_DOCUMENT_BYTES,
  notADocumentMessage,
} from './pdf-library.ts';
export type { DocumentCheck, IncomingDocument, PdfMetadata } from './pdf-library.ts';
export {
  DOCUMENT_EXTENSIONS,
  documentKindOf,
  isEpubName,
  withoutDocumentExtension,
} from './document-kind.ts';
export type { DocumentKind } from './document-kind.ts';
export {
  epubProtection,
  FONT_OBFUSCATION_ALGORITHMS,
  looksLikeEpub,
  protectedEpubMessage,
} from './epub-library.ts';
export type { EpubEncryption, EpubProtection } from './epub-library.ts';
export { bookReference, EPUB_FRAME_SANDBOX, epubFramePolicy } from './epub-frame.ts';
export {
  BOOK_FONT_DEFAULT,
  BOOK_FONT_SIZES,
  bookFontLabel,
  largerBookFont,
  smallerBookFont,
} from './book-font.ts';
export type { BookReference } from './epub-frame.ts';
export {
  bookQuoteAt,
  epubHighlight,
  findInBook,
  foldedText,
  inBookOrder,
  placeByBookWords,
  placeInCfiSection,
  sectionTitle,
  trimmedBookRange,
} from './epub-text.ts';
export type { BookPlacement, BookRange, CfiPlace, ContentsEntry } from './epub-text.ts';
export { placeOfFile } from './document-place.ts';
export {
  highlightChip,
  documentLinkTarget,
  highlightOpening,
  namesDocument,
  placeLabel,
  READER_KINDS,
  readerDocumentOf,
  readerLinkLabel,
  SOURCE_KIND_HUES,
  SOURCE_KIND_NAMES,
} from './highlight-opening.ts';
export type { HighlightChip, HighlightOpening, LiteratureNoteRead } from './highlight-opening.ts';
