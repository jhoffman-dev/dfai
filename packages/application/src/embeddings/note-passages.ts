import {
  blockChunks,
  createVaultPath,
  digestOf,
  noteTitle,
  pageTitle,
  splitFrontmatter,
  type BlockChunk,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { NoteFile } from '../vault/ports.ts';
import type { NoteChunker } from './embedding-build.ts';

/** A note read and cut into the chunks that are embedded. */
export interface NotePassages {
  readonly path: string;
  /** Of the note's whole text, as the index keeps it (`digestOf`): what says it changed. */
  readonly digest: string;
  readonly title: string;
  readonly chunks: readonly BlockChunk[];
}

/**
 * A note file as its chunks: the body after the frontmatter, parsed as the
 * editor parses it, cut by the domain's rules (`blockChunks`) under the
 * note's page title.
 */
export function notePassages(file: NoteFile, markdown: MarkdownPort): NotePassages {
  const path = createVaultPath(file.path);
  const document = splitFrontmatter(file.text);
  const properties = markdown.frontmatterProperties(document.frontmatter);
  const title = pageTitle({ fileTitle: noteTitle(path), properties }).text;
  const { doc } = markdown.parseBody(document.body);
  return {
    path: file.path,
    digest: digestOf(file.text),
    title,
    chunks: blockChunks({ title, doc }),
  };
}

/** Cuts notes in the window itself, on `markdown`: for tests, and where there is no worker. */
export function inlineChunker(markdown: MarkdownPort): NoteChunker {
  return async (files) => files.map((file) => notePassages(file, markdown));
}
