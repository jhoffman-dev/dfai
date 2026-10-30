import type {
  BodyRange,
  EditorDocument,
  MdRoot,
  NoteBlocks,
  ParsedBody,
  RawPart,
} from '@dfai/domain';

/**
 * Turning markdown into an editable document and back. The implementation is a
 * markdown library; the use-cases only need the two directions.
 */
/** How {@link MarkdownPort.frontmatterProperties} reads a block a write is about to change. */
export interface WritingRead {
  readonly forWriting: true;
  /**
   * Keys the caller's rules read. A block listing one of them twice is refused
   * with `FrontmatterRefusedError` naming it, rather than read as its last copy.
   */
  readonly refusingDuplicated?: readonly string[];
}

export interface MarkdownPort {
  parseBody(body: string): ParsedBody;
  /**
   * Frontmatter read as plain values, for indexing. Never used to write it back.
   *
   * Read `forWriting`, a key the block lists twice reads as its last copy —
   * the one {@link MarkdownPort.updateFrontmatter} works around — where the
   * plain read gives up on the block. That is the read a change is held to the
   * task rules against, so the rules see what the write sees; never for showing.
   */
  frontmatterProperties(frontmatter: string | null, read?: WritingRead): Record<string, unknown>;
  /**
   * Why a frontmatter block cannot be read, in one line; null when it can. The
   * properties of such a block read as none, which is right for indexing but
   * not for a file whose settings would then quietly vanish.
   */
  frontmatterProblem(frontmatter: string | null): string | null;
  /** The note's words with the markup removed, for full-text search. */
  plainText(body: string): string;
  /**
   * Where the body's plain words are, by offset: the text the parser read
   * outside any link, reference, footnote, code or HTML.
   */
  textRanges(body: string): BodyRange[];
  /**
   * Each top-level key of the block with the exact text that writes it, for
   * giving it back byte for byte later as a `KeyAsWritten` change. Nothing
   * for a note with no block, or a block whose keys cannot be told apart by line.
   */
  frontmatterKeyTexts(frontmatter: string | null): Record<string, string>;
  /**
   * Changes some frontmatter keys and leaves the rest of the block — its
   * formatting, comments and key order — exactly as it was. A change whose
   * value is null or undefined removes the key rather than writing it; one
   * given as `KeyAsWritten` is written as exactly that text, when it is that
   * key alone, and otherwise removes it. A change to a key the block lists
   * twice throws `FrontmatterRefusedError`, and nothing is written.
   */
  updateFrontmatter(frontmatter: string | null, changes: Readonly<Record<string, unknown>>): string;
  /**
   * Adds `entries` to the map `key` holds — or starts that map — as lines put
   * in after the ones it has, every line of the block left byte for byte. Null
   * when that cannot be done without changing a line already there: `key`
   * holds a list, a sentence or an inline `{…}` map, or already has one of the
   * entries' keys.
   */
  addToFrontmatterMap(
    frontmatter: string,
    key: string,
    entries: Readonly<Record<string, unknown>>,
  ): string | null;
  serializeBody(args: { originalBody: string; parsed: ParsedBody; doc: EditorDocument }): string;
  /**
   * What markdown the editor does not model holds that an export rewrites
   * (P32-07): its links, images, definitions, footnotes, HTML, ids and
   * quotes, by offset, read with `definitions` — the note's own, each as its
   * markdown — in reach, as the note reads them. Nothing in code.
   */
  rawParts(markdown: string, definitions: readonly string[]): RawPart[];
  /**
   * The note's top-level block quotes and what its Obsidian `%%` comments
   * hide, by offset into the whole `text`, frontmatter included: what its
   * highlights are read from (ADR-0043 §2), as the note renders.
   */
  noteBlocks(text: string): NoteBlocks;
  /**
   * A markdown tree written as markdown, one block, as the editor writes a
   * block: what a capture's body is written with (#103, ADR-0049), so its
   * bytes are the editor's own and its escaping the library's.
   */
  writeTree(root: MdRoot): string;
}
