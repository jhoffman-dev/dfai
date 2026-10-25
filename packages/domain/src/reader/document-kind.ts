import type { SourceKind } from '../highlights/anchor.ts';

/*
 * The kinds of source that are a file of the vault the app reads in a reader
 * (#504, #505): a PDF and an EPUB, told apart by their names. A Kindle book
 * has no file, so it is no document.
 */

/** A source that is a file of the vault. */
export type DocumentKind = Extract<SourceKind, 'pdf' | 'epub'>;

/** The extension each document's file name ends in, as the host lists files by it. */
export const DOCUMENT_EXTENSIONS: Readonly<Record<DocumentKind, string>> = {
  pdf: 'pdf',
  epub: 'epub',
};

const DOCUMENT_KINDS = Object.keys(DOCUMENT_EXTENSIONS) as DocumentKind[];

/** Which document a name or a path is, by its extension, or null for any other file. */
export function documentKindOf(name: string): DocumentKind | null {
  const trimmed = name.trim().toLowerCase();
  return DOCUMENT_KINDS.find((kind) => trimmed.endsWith(`.${DOCUMENT_EXTENSIONS[kind]}`)) ?? null;
}

/** Whether a name or a path is an EPUB's. */
export const isEpubName = (name: string): boolean => documentKindOf(name) === 'epub';

const DOCUMENT_ENDING = new RegExp(
  `\\.(${Object.values(DOCUMENT_EXTENSIONS).join('|')})\\s*$`,
  'i',
);

/** `name` without the document extension it ends in (and any space after it). */
export const withoutDocumentExtension = (name: string): string => name.replace(DOCUMENT_ENDING, '');
