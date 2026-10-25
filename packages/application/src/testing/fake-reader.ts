import { lineNoteBlocks } from '@dfai/domain/testing';
import {
  createVaultPath,
  parentVaultPath,
  pdfPageText,
  type PdfMetadata,
  type PdfPageText,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { fakeMarkdown, fakeVaultFs } from './fake-ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { PdfUnreadableError, type PdfDocument, type PdfReaderPort } from '../reader/ports.ts';
import {
  EpubProtectedError,
  EpubUnreadableError,
  type EpubBook,
  type EpubReaderPort,
} from '../reader/epub-ports.ts';

/*
 * Fakes for the reader's use-cases: a vault of files in memory, markdown
 * that reads `key: value` frontmatter with JSON-quoted strings as the real
 * one writes them, a PDF reader that answers pages of given words, and an
 * EPUB reader that answers chapters of given words.
 */

/** A vault in memory: notes as text, other files as bytes, folders as names. */
export function memoryFiles(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, string | Uint8Array>(Object.entries(initial));
  const folders = new Set<string>(['']);
  for (const path of files.keys()) addFolders(folders, path);
  let modified = 100;
  const listDirectory = async (path: VaultPath): Promise<readonly VaultEntry[]> => {
    if (!folders.has(path)) throw new Error(`no folder ${path}`);
    const prefix = path === '' ? '' : `${path}/`;
    const names = new Set<string>();
    for (const key of [...files.keys(), ...folders]) {
      if (key.startsWith(prefix) && key !== path)
        names.add(key.slice(prefix.length).split('/')[0] as string);
    }
    return [...names].map((name) => {
      const at = createVaultPath(`${prefix}${name}`);
      return folders.has(at)
        ? { kind: 'directory', name, path: at }
        : { kind: 'file', name, path: at };
    }) as VaultEntry[];
  };
  const fs: VaultFsPort = fakeVaultFs({
    listDirectory,
    // As the host walks: told folders skipped, no deeper than asked.
    listFiles: async ({ extension, skipDirectories, maxDepth }) =>
      [...files.keys()]
        .filter((path) => {
          const folders = path.split('/').slice(0, -1);
          return (
            path.toLowerCase().endsWith(`.${extension.toLowerCase()}`) &&
            folders.length <= maxDepth &&
            !folders.some((folder) => skipDirectories.includes(folder))
          );
        })
        .map((path) => createVaultPath(path)),
    createFolder: async ({ path }) => {
      if (folders.has(path) || files.has(path)) throw new Error('already exists');
      folders.add(path);
    },
    createNote: async ({ path, contents }) => {
      if (files.has(path)) throw new Error('a note with that name already exists');
      files.set(path, contents);
      return (modified += 1);
    },
    writeBinaryFile: async ({ path, bytes, offset }) => {
      if (offset === 0 && files.has(path)) throw new Error('a file with that name already exists');
      if (!folders.has(parentVaultPath(path))) throw new Error('no such folder');
      files.set(path, bytes.slice());
      return bytes.length;
    },
    trashEntry: async ({ path }) => {
      if (!files.delete(path)) throw new Error(`nothing at ${path}`);
    },
    readTextFile: async (path) => {
      const text = files.get(path);
      if (typeof text !== 'string') throw new Error(`no note ${path}`);
      return { text, modified };
    },
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = files.get(path);
        return typeof text === 'string' ? [{ path, text, modified, size: text.length }] : [];
      }),
    writeTextFile: async ({ path, contents, expectedText }) => {
      if (expectedText !== undefined && files.get(path) !== expectedText)
        throw new Error('changed');
      files.set(path, contents);
      return (modified += 1);
    },
  });
  return { fs, files, folders };
}

function addFolders(folders: Set<string>, path: string): void {
  const parts = path.split('/').slice(0, -1);
  for (let at = 1; at <= parts.length; at += 1) folders.add(parts.slice(0, at).join('/'));
}

/** Markdown whose frontmatter is `key: value` lines, a quoted or bracketed value read as JSON, and whose blocks are found line by line. */
export function readerMarkdown(): MarkdownPort {
  return {
    ...fakeMarkdown(),
    noteBlocks: lineNoteBlocks,
    frontmatterProperties: (frontmatter) =>
      Object.fromEntries(
        (frontmatter ?? '').split('\n').flatMap((line) => {
          const found = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
          if (found === null) return [];
          const value = (found[2] ?? '').trim();
          return [[found[1], /^["[]/.test(value) ? (JSON.parse(value) as unknown) : value]];
        }),
      ),
  };
}

/** A page whose words are one run per line, each line 0.02 high and 0.01 wide a character. */
export function linesPage(...lines: string[]): PdfPageText {
  return pdfPageText(
    lines.map((text, at) => ({
      text,
      box: { x: 0.1, y: 0.1 + at * 0.03, width: text.length * 0.01, height: 0.02 },
      endsLine: at < lines.length - 1,
    })),
  );
}

/** A PDF of these pages and this metadata, counting the pages whose text was asked for. */
export function fakePdf(
  pages: readonly PdfPageText[],
  metadata: PdfMetadata = { title: null, author: null },
): PdfDocument & { readonly textsRead: number[]; closed: boolean } {
  const textsRead: number[] = [];
  const document = {
    pageCount: pages.length,
    textsRead,
    closed: false,
    pageSize: async () => ({ width: 612, height: 792 }),
    pageText: async (page: number) => {
      textsRead.push(page);
      const text = pages[page - 1];
      if (text === undefined) throw new Error(`no page ${page}`);
      return text;
    },
    metadata: async () => metadata,
    outline: async () => [],
    close: async () => {
      document.closed = true;
    },
  };
  return document;
}

/** A reader that opens every PDF as `document`, or refuses bytes that do not start `%PDF-`. */
export function fakeReader(document: PdfDocument): PdfReaderPort {
  return {
    open: async (bytes) => {
      if (!new TextDecoder().decode(bytes.subarray(0, 5)).startsWith('%PDF-')) {
        throw new PdfUnreadableError('it is damaged');
      }
      return document;
    },
  };
}

export const pdfBytes = (body = '') => new TextEncoder().encode(`%PDF-1.4\n${body}`);

/**
 * A book of these chapters' texts, counting the chapters whose text was
 * asked for. Its CFIs are made up — `epubcfi(/6/<2(n+1)>!/<start>:<end>)` —
 * and read back by the same pattern; any other names no place in it.
 */
export function fakeBook(
  sections: readonly string[],
  metadata: PdfMetadata = { title: null, author: null },
): EpubBook & { readonly textsRead: number[]; closed: boolean } {
  const textsRead: number[] = [];
  const book = {
    sectionCount: sections.length,
    metadata,
    contents: [],
    textsRead,
    closed: false,
    sectionText: async (section: number) => {
      textsRead.push(section);
      const text = sections[section];
      if (text === undefined) throw new Error(`no chapter ${section}`);
      return text;
    },
    cfiOf: async ({ section, start, end }: { section: number; start: number; end: number }) =>
      `epubcfi(/6/${(section + 1) * 2}!/${start}:${end})`,
    placeOfCfi: async (cfi: string) => {
      const found = /^epubcfi\(\/6\/(\d+)(?:!\/(\d+):(\d+))?/.exec(cfi);
      if (found === null) return null;
      const section = Number(found[1]) / 2 - 1;
      if (section < 0 || section >= sections.length) return null;
      if (found[2] === undefined) return { section, range: null };
      return { section, range: { section, start: Number(found[2]), end: Number(found[3]) } };
    },
    close: () => {
      book.closed = true;
    },
  };
  return book;
}

/** A reader that opens every EPUB as `book`, refuses bytes that are no ZIP, and refuses a DRM-locked one. */
export function fakeEpubReader(book: EpubBook, { locked = false } = {}): EpubReaderPort {
  return {
    open: async (bytes) => {
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new EpubUnreadableError('it is damaged');
      if (locked) throw new EpubProtectedError();
      return book;
    },
  };
}

/** Bytes that start as an EPUB does: a ZIP archive's local header. */
export const epubBytes = (body = '') =>
  new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(body)]);
