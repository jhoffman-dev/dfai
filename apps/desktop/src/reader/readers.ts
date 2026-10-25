/*
 * Both readers, and the pdf.js and foliate-js they read with, gathered so that
 * one dynamic import splits them off together (`pages-on-first-use.ts`). In
 * chunks of their own, the code the two share and each reader's library, which
 * adding a document also loads, landed in chunks the readers imported
 * statically: one that failed to load kept its reader broken past Reload
 * (#552, #560). Preloading fetched them all anyway.
 */
export { appEpubReader } from './app-epub-reader.ts';
export { appPdfReader } from './app-pdf-reader.ts';
export { BookReaderTab } from './book-reader-tab.tsx';
export { DocumentReader } from './document-reader.tsx';
