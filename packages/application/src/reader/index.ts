export { addPdfToLibrary, PdfNotAddedError } from './add-pdf.ts';
export type { AddPdfPorts } from './add-pdf.ts';
export { addEpubToLibrary, EpubNotAddedError } from './add-epub.ts';
export type { AddEpubPorts } from './add-epub.ts';
export type { AddedDocument, PickedDocument } from './library-copy.ts';
export { EpubProtectedError, EpubUnreadableError } from './epub-ports.ts';
export type { EpubBook, EpubReaderPort, YieldToHost } from './epub-ports.ts';
export {
  allSectionTexts,
  highlightBookSelection,
  placeBookHighlights,
  searchBook,
} from './epub-highlights.ts';
export type { PlacedBookHighlight } from './epub-highlights.ts';
export { findLiteratureNote } from './find-literature-note.ts';
export type { FindLiteratureNotePorts } from './find-literature-note.ts';
export { allPageTexts, placeHighlights } from './place-highlights.ts';
export type { PlacedHighlight } from './place-highlights.ts';
export {
  highlightArea,
  highlightSelection,
  NothingToHighlightError,
  readLiteratureNoteAt,
} from './pdf-highlights.ts';
export type { ReadLiteratureNote } from './pdf-highlights.ts';
export { PdfUnreadableError } from './ports.ts';
export type { PdfDocument, PdfOutlineEntry, PdfPageSize, PdfReaderPort } from './ports.ts';
export {
  linkedDocument,
  openHighlightPlace,
  readerHighlightLinks,
  whereHighlightOpens,
} from './open-highlight-place.ts';
export type {
  HighlightPlaceOpener,
  HighlightPlacePorts,
  LinkedDocumentPorts,
  ReaderHighlightLinks,
} from './open-highlight-place.ts';
