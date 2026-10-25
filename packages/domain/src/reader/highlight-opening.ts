import type { HighlightAnchor, SourceKind } from '../highlights/anchor.ts';
import type { HighlightBlock } from '../highlights/highlight-block.ts';
import type { LiteratureNote } from '../highlights/literature-note.ts';
import type { PillHue } from '../page/pill-colour.ts';
import { composed } from '../markdown/resolve-wikilink.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { documentKindOf, type DocumentKind } from './document-kind.ts';

/*
 * Where a highlight opens when it is followed (#506, ADR-0043): a transcluded
 * highlight, a link to one, or a highlight in its own literature note. A
 * source DFAI can read in the app opens in its reader at the highlight; any
 * other — a Kindle book (DRM), a block that is not a highlight — opens its
 * note at the block, as any block link does.
 */

/** The kinds of source with a reader in the app: PDF (#504) and EPUB (#505). */
export const READER_KINDS: readonly SourceKind[] = ['pdf', 'epub'];

/** What following a block of a note opens. */
export type HighlightOpening =
  /** The source's reader, brought to the highlight `highlightId`. */
  | {
      readonly kind: 'reader';
      readonly source: SourceKind;
      readonly document: VaultPath;
      readonly highlightId: string;
    }
  /** The note, at block `blockId`. */
  | { readonly kind: 'note'; readonly note: VaultPath; readonly blockId: string };

/** What a literature note says, and the highlights it holds, for the rules that follow one. */
export interface LiteratureNoteRead {
  readonly source: LiteratureNote;
  readonly highlightIds: readonly string[];
}

/**
 * Where following block `blockId` of `note` leads. `literature` is null for a
 * note that is not a literature note; `readers` is which kinds of source the
 * app can open, `READER_KINDS` unless a test says otherwise.
 */
export function highlightOpening({
  note,
  blockId,
  literature,
  readers = READER_KINDS,
}: {
  note: VaultPath;
  blockId: string;
  literature: LiteratureNoteRead | null;
  readers?: readonly SourceKind[];
}): HighlightOpening {
  const inNote: HighlightOpening = { kind: 'note', note, blockId };
  if (literature === null || !literature.highlightIds.includes(blockId)) return inNote;
  const { kind, file } = literature.source;
  if (file === null || !opensInReader(literature.source, readers)) return inNote;
  return { kind: 'reader', source: kind, document: file, highlightId: blockId };
}

/** What each kind of source is called to the person. */
export const SOURCE_KIND_NAMES: Readonly<Record<SourceKind, string>> = {
  pdf: 'PDF',
  epub: 'EPUB',
  kindle: 'Kindle',
};

/**
 * What a highlight in its own literature note offers to open it with —
 * "Open in PDF" — or null where it has no reader in the app, so stays where
 * it is.
 */
export function readerLinkLabel(
  source: LiteratureNote | null,
  readers: readonly SourceKind[] = READER_KINDS,
): string | null {
  if (source === null || !opensInReader(source, readers)) return null;
  return `Open in ${SOURCE_KIND_NAMES[source.kind]}`;
}

/**
 * Whether the app can show `source`'s file in a reader: it names a file, its
 * kind has a reader, and the file is one that reader opens. `file:` is
 * hand-editable, so a note saying `kind: pdf` may name a Markdown note.
 */
function opensInReader(source: LiteratureNote, readers: readonly SourceKind[]): boolean {
  if (source.file === null || !readers.includes(source.kind)) return false;
  return documentKindOf(source.file) === source.kind;
}

/**
 * The file a literature note's bar offers to open in its reader ("Open PDF",
 * "Open EPUB"), and the words; null for a note whose source has no reader.
 */
export function readerDocumentOf(
  source: LiteratureNote | null,
  readers: readonly SourceKind[] = READER_KINDS,
): { readonly file: VaultPath; readonly label: string } | null {
  if (source === null || source.file === null || !opensInReader(source, readers)) return null;
  return { file: source.file, label: `Open ${SOURCE_KIND_NAMES[source.kind]}` };
}

/** The muted pastel a source's kind is drawn in (#413's hues): the same for every chip of a kind. */
export const SOURCE_KIND_HUES: Readonly<Record<SourceKind, PillHue>> = {
  pdf: 'red',
  epub: 'green',
  kindle: 'orange',
};

/** The small chip a transcluded highlight wears: where it is from, and where in it. */
export interface HighlightChip {
  readonly kind: SourceKind;
  readonly hue: PillHue;
  /** The source's title, as its literature note gives it. */
  readonly title: string;
  /** `p. 3`, `loc. 1234`; null where the source has no page or location to name (an EPUB's CFI). */
  readonly place: string | null;
  /** Whether following it opens the source's reader (`highlightOpening`), rather than its note. */
  readonly opensInReader: boolean;
}

/** The chip of highlight `highlight`, from the literature note `source`. */
export function highlightChip(
  source: LiteratureNote,
  highlight: HighlightBlock,
  readers: readonly SourceKind[] = READER_KINDS,
): HighlightChip {
  return {
    kind: source.kind,
    hue: SOURCE_KIND_HUES[source.kind],
    title: source.title,
    place: placeLabel(highlight.anchor),
    opensInReader: readerLinkLabel(source, readers) !== null,
  };
}

/** Where in its source a highlight is, as a reader names it: a page, or a Kindle location. */
export function placeLabel(anchor: HighlightAnchor): string | null {
  if (anchor.kind === 'pdf') return `p. ${anchor.page}`;
  if (anchor.kind === 'epub') return null;
  if (anchor.location !== null) return `loc. ${anchor.location.start}`;
  return anchor.page === undefined ? null : `p. ${anchor.page}`;
}

/**
 * The document a wiki link's target writes the name of — it ends `.pdf` or
 * `.epub` — whether or not the vault has one; null for any other link.
 */
export const namesDocument = (target: string): DocumentKind | null => documentKindOf(target);

/**
 * The document a wiki link `[[…pdf]]` or `[[…epub]]` names among `files`,
 * the vault's files of that kind, or null when none matches (or the link
 * names no document, or a file of another kind). As in
 * Obsidian, a link writes the end of a path: its name alone, or the folders
 * above it that tell two apart. Where several files match, one is chosen
 * the same way every time: the exact path, else the shortest path, else the
 * first alphabetically. A link never names a file that is not in `files`.
 * Accents are compared composed, as note links compare them: a name written
 * to disk decomposed is the same name typed composed.
 */
export function documentLinkTarget(target: string, files: readonly VaultPath[]): VaultPath | null {
  const written = comparable(target.trim().replace(/^\/+/, ''));
  const kind = documentKindOf(written);
  if (kind === null) return null;
  const matching = [...new Set(files)].filter(
    (path) => documentKindOf(path) === kind && endsWithPath(comparable(path), written),
  );
  matching.sort(
    (a, b) =>
      Number(comparable(b) === written) - Number(comparable(a) === written) ||
      a.length - b.length ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  return matching[0] ?? null;
}

/** A path as a document link compares it: accents composed, case folded. */
const comparable = (path: string): string => composed(path).toLowerCase();

/** Whether `path` is `written`, or ends with it at a folder boundary. */
const endsWithPath = (path: string, written: string): boolean =>
  path === written || path.endsWith(`/${written}`);
