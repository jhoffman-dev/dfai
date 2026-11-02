import {
  anchoredBlocks,
  checklistLines,
  checklistProgress,
  createVaultPath,
  createWikiLinkResolver,
  declaresImport,
  digestOf,
  highlightRows,
  importOutcomeOf,
  indexablePropertiesOf,
  isLiteratureNote,
  linkLeaf,
  mayHoldBlockIds,
  mayHoldChecklist,
  noteTags,
  noteTitle,
  pageTitle,
  relationsOf,
  splitFrontmatter,
  splitWikiLinks,
  summaryOf,
  TAGS_KEY,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { noteTypeName } from '../types/load-types.ts';
import type { WrittenAt } from '../vault/ports.ts';
import type { IndexedNote } from './ports.ts';

/** Everything the index should know about one note. */
export function toIndexedNote({
  file,
  notePaths,
  markdown,
  resolveLink = createWikiLinkResolver(notePaths),
}: {
  file: WrittenAt & { path: string; text: string; modified: number; size: number };
  notePaths: readonly VaultPath[];
  markdown: MarkdownPort;
  /** How a link finds its note among `notePaths` — built once when many notes are read. */
  resolveLink?: (target: string) => VaultPath | null;
}): IndexedNote {
  const path = createVaultPath(file.path);
  const document = splitFrontmatter(file.text);
  const frontmatter = markdown.frontmatterProperties(document.frontmatter);
  const importOutcome = importOutcomeOf(frontmatter);

  const body = markdown.plainText(document.body);

  return {
    path: file.path,
    title: pageTitle({ fileTitle: noteTitle(path), properties: frontmatter }).text,
    modified: file.modified,
    ...(file.modifiedAt !== undefined && { modifiedAt: file.modifiedAt }),
    size: file.size,
    type: noteTypeName(frontmatter),
    digest: digestOf(file.text),
    ...(importOutcome !== null && { importOutcome }),
    ...(declaresImport(frontmatter) && { importDeclared: true as const }),
    body,
    summary: summaryOf(document.body),
    properties: indexablePropertiesOf(frontmatter),
    links: linksIn(document.body, resolveLink),
    relations: relationsOf(frontmatter, resolveLink),
    tags: noteTags({
      tagsProperty: frontmatter[TAGS_KEY],
      body: document.body,
      ranges: markdown.textRanges(document.body),
    }),
    ...readBlocks(document.body, markdown),
    highlights: isLiteratureNote(frontmatter)
      ? highlightRows(file.text, (text) => markdown.noteBlocks(text))
      : [],
  };
}

/**
 * The note's blocks with ids (P26-01) and its checklist (P30-03), read as the
 * editor reads them, the body parsed once for both. A body with no line
 * ending as an id would has no ids, and one with no line starting with a box
 * has no checklist; a body with neither is not parsed at all.
 */
function readBlocks(
  body: string,
  markdown: MarkdownPort,
): Pick<IndexedNote, 'blocks' | 'checks' | 'progress'> {
  const anchored = mayHoldBlockIds(body);
  const boxed = mayHoldChecklist(body);
  const doc = anchored || boxed ? markdown.parseBody(body).doc : null;
  const lines = doc !== null && boxed ? checklistLines(doc) : [];
  return {
    blocks: doc !== null && anchored ? anchoredBlocks(doc) : [],
    checks: lines.map(({ done, text }) => ({ done, text })),
    progress: checklistProgress(lines),
  };
}

function linksIn(body: string, resolveLink: (target: string) => VaultPath | null) {
  return splitWikiLinks(body)
    .filter((piece) => piece.kind === 'wikiLink')
    .map((link) => ({
      target: link.target,
      leaf: linkLeaf(link.target),
      path: resolveLink(link.target),
      kind: 'wikilink' as const,
    }));
}
