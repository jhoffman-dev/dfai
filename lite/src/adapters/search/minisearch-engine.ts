import MiniSearch from 'minisearch';
import type { SearchEngine, SearchHit } from '../../application/index.ts';
import { noteTitle, type VaultPath } from '../../domain/vault/index.ts';

interface IndexedDoc {
  readonly id: VaultPath;
  readonly title: string;
  readonly text: string;
}

/** How much text a snippet shows either side of the hit. */
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

function newIndex(): MiniSearch<IndexedDoc> {
  return new MiniSearch<IndexedDoc>({
    fields: ['title', 'text'],
    searchOptions: {
      boost: { title: 3 },
      prefix: true,
      fuzzy: 0.2,
      combineWith: 'AND',
    },
  });
}

/** The line or two around the first place one of `terms` appears, as plain text. */
function snippetOf(text: string, terms: readonly string[]): string {
  const folded = text.toLowerCase();
  const hits = terms.map((term) => folded.indexOf(term.toLowerCase())).filter((at) => at >= 0);
  const at = hits.length === 0 ? 0 : Math.min(...hits);
  const start = wordStartAtOrAfter(text, Math.max(0, at - SNIPPET_BEFORE), at);
  const end = Math.min(text.length, at + SNIPPET_AFTER);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** `from`, moved on to the start of a word so a snippet never opens mid-word (never past `limit`). */
function wordStartAtOrAfter(text: string, from: number, limit: number): number {
  if (from === 0 || /\s/.test(text[from - 1] ?? ' ')) return from;
  const space = text.slice(from, limit).search(/\s/);
  return space === -1 ? limit : from + space + 1;
}

/**
 * The `SearchEngine` port on MiniSearch: prefix and fuzzy matching, titles
 * boosted. Keeps each note's text beside the index, so a hit can show a snippet.
 */
export function createMiniSearchEngine(): SearchEngine {
  let index = newIndex();
  const texts = new Map<VaultPath, string>();
  const docOf = (path: VaultPath, text: string): IndexedDoc => ({
    id: path,
    title: noteTitle(path),
    text,
  });

  return {
    index(notes) {
      index = newIndex();
      texts.clear();
      for (const { path, text } of notes) texts.set(path, text);
      index.addAll(notes.map(({ path, text }) => docOf(path, text)));
    },
    update(path, text) {
      texts.set(path, text);
      if (index.has(path)) index.replace(docOf(path, text));
      else index.add(docOf(path, text));
    },
    remove(path) {
      texts.delete(path);
      if (index.has(path)) index.discard(path);
    },
    search(query, { limit = 20 } = {}): SearchHit[] {
      if (query.trim() === '') return [];
      return index
        .search(query)
        .slice(0, limit)
        .map((result) => {
          const path = result.id as VaultPath;
          return {
            path,
            title: noteTitle(path),
            snippet: snippetOf(texts.get(path) ?? '', result.terms),
          };
        });
    },
  };
}
