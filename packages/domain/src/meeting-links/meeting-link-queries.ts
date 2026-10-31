import { foldedTypeSql } from '../types/note-type-sql.ts';
import { outsideArchiveSql } from '../archive/archive.ts';
import { COMPANY_TYPE } from '../people/company.ts';
import { PERSON_TYPE } from '../people/person.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import { ALIASES_KEY } from '../terms/term.ts';
import { PROJECT_TYPE } from '../types/para.ts';
import { paraFiledUnderSql } from '../types/para-value.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import type { DirectoryCompany, DirectoryPerson } from './attendee-matching.ts';
import { MEETING_LINK_KEYS, MEETING_PROJECT_KEY } from './meeting-link-keys.ts';
import { CLOSED_PROJECT_STATUSES } from './meeting-series.ts';

/** Rows per page of the directory: the host hands back at most 5,000 at once. */
export const LINK_DIRECTORY_PAGE_SIZE = 5000;

/** The keys a person's or a company's note is matched by. */
export const PERSON_EMAIL_KEY = 'email';
export const PERSON_OTHER_EMAILS_KEY = 'other_emails';
export const PERSON_COMPANY_KEY = 'company';
export const COMPANY_DOMAINS_KEY = 'domains';
export const COMPANY_SITE_KEY = 'site';

const DIRECTORY_TYPES = [PERSON_TYPE, COMPANY_TYPE] as const;
const DIRECTORY_KEYS = [
  PERSON_EMAIL_KEY,
  PERSON_OTHER_EMAILS_KEY,
  ALIASES_KEY,
  COMPANY_DOMAINS_KEY,
  COMPANY_SITE_KEY,
] as const;

/**
 * One page of the people and companies a meeting's attendees are matched
 * against: a row per item of the keys they are matched by — and, for a
 * person, a row for the company their `company` links, resolved — and one row
 * with no key for a note that has none. Columns: path, title, type, key,
 * value; a note's rows arrive together.
 *
 * A note is a person or a company as `@` and the Terms page count it (any
 * item of its `type`; the first named when it names both). Archived ones are
 * read too: a link to one still opens it, and proposing them anew would make
 * a second note of someone the vault knows. Notes in `.atlas` and hidden
 * folders are not.
 */
export function compileLinkDirectoryQuery(page: number): CompiledQuery {
  const types = DIRECTORY_TYPES.map(() => '?').join(', ');
  const keys = DIRECTORY_KEYS.map(() => '?').join(', ');
  return {
    sql: `/* meeting links: directory */ SELECT "path", "title", "type", "key", "value" FROM (
  SELECT files.path AS "path", files.title AS "title",
         (SELECT ${foldedTypeSql('typed.value_text')} FROM props AS typed
           WHERE typed.path = files.path AND typed.key = 'type' AND ${foldedTypeSql('typed.value_text')} IN (${types})
           ORDER BY typed.idx LIMIT 1) AS "type",
         item.key AS "key", item.value_text AS "value", item.idx AS "idx"
    FROM files
    LEFT JOIN props AS item ON item.path = files.path AND item.key IN (${keys})
   WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} IN (${types}))
     AND ${userSpaceNoteSql('files.path')}
  UNION ALL
  SELECT relations.src, files.title, NULL, relations.key, relations.dst, relations.idx
    FROM relations JOIN files ON files.path = relations.src
   WHERE relations.key = ? AND relations.dst IS NOT NULL
     AND relations.src IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = ?)
     AND ${userSpaceNoteSql('files.path')}
) ORDER BY "path", "key", "idx" LIMIT ? OFFSET ?`,
    parameters: [
      ...DIRECTORY_TYPES,
      ...DIRECTORY_KEYS,
      ...DIRECTORY_TYPES,
      PERSON_COMPANY_KEY,
      PERSON_TYPE,
      LINK_DIRECTORY_PAGE_SIZE,
      page * LINK_DIRECTORY_PAGE_SIZE,
    ],
  };
}

/** A row of {@link compileLinkDirectoryQuery}. */
export interface LinkDirectoryRow {
  readonly path: string;
  readonly title: string;
  /** Null on a person's company row: the note's other rows say what it is. */
  readonly type: string | null;
  readonly key: string | null;
  readonly value: string | null;
}

/** The vault's people and companies, as matching reads them. */
export interface LinkDirectory {
  readonly people: readonly DirectoryPerson[];
  readonly companies: readonly DirectoryCompany[];
}

/** The people and companies the rows describe, in path order. */
export function linkDirectoryOf(rows: readonly LinkDirectoryRow[]): LinkDirectory {
  const people: DirectoryPerson[] = [];
  const companies: DirectoryCompany[] = [];
  for (const note of notesOf(rows)) {
    const path = createVaultPath(note.path);
    const aliases = note.values(ALIASES_KEY);
    if (note.type === COMPANY_TYPE) {
      const domains = [...note.values(COMPANY_DOMAINS_KEY), ...note.values(COMPANY_SITE_KEY)];
      companies.push({ path, name: note.title, aliases, domains });
    } else if (note.type === PERSON_TYPE) {
      const emails = [...note.values(PERSON_EMAIL_KEY), ...note.values(PERSON_OTHER_EMAILS_KEY)];
      const company = note.values(PERSON_COMPANY_KEY)[0];
      people.push({
        path,
        name: note.title,
        emails,
        aliases,
        company: company === undefined ? null : createVaultPath(company),
      });
    }
  }
  return { people, companies };
}

/**
 * The open projects tied to any of `entities` — the people and companies a
 * meeting is linked to — one row per tie. A project is tied to a person or a
 * company when either note links the other, or when another note (an earlier
 * meeting, a task) links both the project in its `project` and them in its
 * `people` or `companies`. The meeting itself is left out, so linking it
 * never makes its own evidence. A project is open while it is outside the
 * Archive, its PARA is project or area — not resource, not archive (#213) —
 * and its status is not done, cancelled or dropped. Columns: project,
 * title, entity. Every value is bound.
 *
 * The other-note ties are read project first — each open project, the notes
 * filed under it, then whom those notes link — so the work grows with the
 * notes filed under open projects. `CROSS JOIN` holds SQLite to that order,
 * and `+other.dst` keeps it reading a filed note's links by the note, not by
 * the person. Left to choose, with no statistics it could start from the
 * people and look each of their notes up once per open project, or read
 * every note naming the person again for each project or filed note: either
 * ran a person in a thousand meetings out of the query budget (#143).
 */
export function compileProjectTiesQuery({
  meeting,
  entities,
}: {
  meeting: string;
  entities: readonly string[];
}): CompiledQuery {
  const among = entities.map(() => '?').join(', ');
  const closed = CLOSED_PROJECT_STATUSES.map(() => '?').join(', ');
  const linkKeys = MEETING_LINK_KEYS.map(() => '?').join(', ');
  return {
    sql: `/* meeting links: projects */ WITH open_projects AS (
  SELECT files.path AS path, files.title AS title FROM files
   WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = ?)
     AND ${userSpaceNoteSql('files.path')} AND ${outsideArchiveSql('files.path')}
     AND ${paraFiledUnderSql('files.path')}
     AND NOT EXISTS (SELECT 1 FROM props AS state WHERE state.path = files.path
                      AND state.key = 'status' AND lower(state.value_text) IN (${closed}))
)
SELECT open_projects.path AS "project", open_projects.title AS "title", relations.dst AS "entity"
  FROM open_projects JOIN relations ON relations.src = open_projects.path
 WHERE relations.dst IN (${among})
UNION
SELECT open_projects.path, open_projects.title, relations.src
  FROM open_projects JOIN relations ON relations.dst = open_projects.path
 WHERE relations.src IN (${among})
UNION
SELECT open_projects.path, open_projects.title, other.dst
  FROM open_projects
  CROSS JOIN relations AS filed ON filed.dst = open_projects.path AND filed.key = ?
  CROSS JOIN relations AS other ON other.src = filed.src AND other.key IN (${linkKeys})
 WHERE +other.dst IN (${among}) AND filed.src <> ?
ORDER BY 1, 3`,
    parameters: [
      PROJECT_TYPE,
      ...CLOSED_PROJECT_STATUSES,
      ...entities,
      ...entities,
      MEETING_PROJECT_KEY,
      ...MEETING_LINK_KEYS,
      ...entities,
      meeting,
    ],
  };
}

/** The rows gathered per note, in the order they came. */
function notesOf(rows: readonly LinkDirectoryRow[]) {
  const notes = new Map<
    string,
    { title: string; type: string | null; items: [string, string][] }
  >();
  for (const row of rows) {
    const note = notes.get(row.path) ?? { title: row.title, type: null, items: [] };
    note.type ??= row.type;
    if (row.key !== null && row.value !== null) note.items.push([row.key, row.value]);
    notes.set(row.path, note);
  }
  return [...notes].map(([path, { title, type, items }]) => ({
    path,
    title,
    type,
    values: (wanted: string) =>
      items
        .filter(([key]) => key === wanted)
        .map(([, value]) => value.trim())
        .filter(Boolean),
  }));
}
