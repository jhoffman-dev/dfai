import { foldedTypeSql } from '../types/note-type-sql.ts';
import { outsideArchiveSql } from '../archive/archive.ts';
import { COMPANY_TYPE } from '../people/company.ts';
import { PERSON_TYPE } from '../people/person.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import { ALIASES_KEY, TERM_KIND_KEY, TERM_TYPE, termKindOf, VARIANTS_KEY } from './term.ts';
import type { TermNote } from './term.ts';
import type { NamedEntity, VocabularySources } from './vocabulary.ts';

/** Rows per page of the vocabulary's notes: the host hands back at most 5,000 at once. */
export const VOCABULARY_PAGE_SIZE = 5000;

/** The types the vocabulary reads, bound in this order wherever the query names them. */
export const VOCABULARY_TYPES = [TERM_TYPE, PERSON_TYPE, COMPANY_TYPE] as const;

/**
 * One page of what the vocabulary is built from: every term, person and
 * company, with each item of the lists that hold their other spellings — one
 * row per item, and one row with no key for a note that has none. Columns:
 * path, title, type, key, value; in path order, then by key and place in the
 * list, so a note's rows arrive together.
 *
 * A note is one of them when any item of its `type` is, as `@` and a type's
 * page count it (`type: [contact, person]` is a person). A note whose types
 * name more than one of them is the first it names: `type: [company, person]`
 * is a company, its name and aliases read once. Only the vault's own notes
 * are read — not a template in `.atlas`, nor anything in a hidden folder or
 * the Archive, which is where a term goes when it is retired.
 */
export function compileVocabularyQuery(page: number): CompiledQuery {
  const named = VOCABULARY_TYPES.map(() => '?').join(', ');
  return {
    sql: `/* terms:notes */ SELECT files.path AS "path", files.title AS "title",
        (SELECT ${foldedTypeSql('typed.value_text')} FROM props AS typed
          WHERE typed.path = files.path AND typed.key = 'type' AND ${foldedTypeSql('typed.value_text')} IN (${named})
          ORDER BY typed.idx LIMIT 1) AS "type",
        spelt.key AS "key", spelt.value_text AS "value"
 FROM files
 LEFT JOIN props AS spelt ON spelt.path = files.path AND spelt.key IN (?, ?, ?)
 WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} IN (${named}))
   AND ${userSpaceNoteSql('files.path')} AND ${outsideArchiveSql('files.path')}
 ORDER BY files.path, spelt.key, spelt.idx LIMIT ? OFFSET ?`,
    parameters: [
      ...VOCABULARY_TYPES,
      VARIANTS_KEY,
      TERM_KIND_KEY,
      ALIASES_KEY,
      ...VOCABULARY_TYPES,
      VOCABULARY_PAGE_SIZE,
      page * VOCABULARY_PAGE_SIZE,
    ],
  };
}

/** A row of {@link compileVocabularyQuery}. */
export interface VocabularyRow {
  readonly path: string;
  readonly title: string;
  readonly type: string;
  readonly key: string | null;
  readonly value: string | null;
}

/**
 * The terms, people and companies the rows describe, terms in the order of
 * their right spellings. A term's other spellings are its `variants`; a
 * person's or a company's are its `aliases`, which only link, and its
 * `variants`, which correct to its name as a term's do. A `kind` DFAI does
 * not know is no kind.
 */
export function vocabularySourcesOf(rows: readonly VocabularyRow[]): VocabularySources {
  const terms: TermNote[] = [];
  const people: NamedEntity[] = [];
  const companies: NamedEntity[] = [];
  for (const note of notesOf(rows)) {
    const path = createVaultPath(note.path);
    if (note.type === TERM_TYPE) {
      terms.push({
        path,
        canonical: note.title,
        variants: note.values(VARIANTS_KEY),
        kind: termKindOf(note.values(TERM_KIND_KEY)[0]),
      });
    } else {
      const named = {
        path,
        name: note.title,
        aliases: note.values(ALIASES_KEY),
        variants: note.values(VARIANTS_KEY),
      };
      (note.type === COMPANY_TYPE ? companies : people).push(named);
    }
  }
  return { terms: terms.sort(byCanonical), people, companies };
}

/** The rows gathered per note, in the order they came. */
function notesOf(rows: readonly VocabularyRow[]) {
  const notes = new Map<string, { row: VocabularyRow; spelt: [string, string][] }>();
  for (const row of rows) {
    const note = notes.get(row.path) ?? { row, spelt: [] };
    if (row.key !== null && row.value !== null) note.spelt.push([row.key, row.value]);
    notes.set(row.path, note);
  }
  return [...notes.values()].map(({ row, spelt }) => ({
    path: row.path,
    title: row.title,
    type: row.type,
    values: (wanted: string) => spelt.filter(([key]) => key === wanted).map(([, value]) => value),
  }));
}

/** Terms in the order of their right spellings, whatever their case, then by path. */
export function byCanonical(left: TermNote, right: TermNote): number {
  const [a, b] = [left.canonical.toLowerCase(), right.canonical.toLowerCase()];
  if (a !== b) return a < b ? -1 : 1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
