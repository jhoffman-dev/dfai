import {
  compileLinkDirectoryQuery,
  compileMeetingEntitiesQuery,
  compileProjectTiesQuery,
  createVaultPath,
  LINK_DIRECTORY_PAGE_SIZE,
  linkDirectoryOf,
  type LinkDirectory,
  type LinkDirectoryRow,
  type ProjectTie,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort, QueryResult } from '../index/ports.ts';

/**
 * The vault's people and companies as attendees are matched against them,
 * read from the index a page at a time — never from the files themselves,
 * however many people the vault holds.
 */
export async function loadLinkDirectory({
  index,
}: {
  index: Pick<IndexPort, 'query'>;
}): Promise<LinkDirectory> {
  const rows: LinkDirectoryRow[] = [];
  for (let page = 0; ; page += 1) {
    const { sql, parameters } = compileLinkDirectoryQuery(page);
    const result = await index.query(sql, parameters);
    const cell = cellsOf(result);
    rows.push(
      ...result.rows.map((row) => ({
        path: String(cell(row, 'path')),
        title: String(cell(row, 'title') ?? ''),
        type: textOrNull(cell(row, 'type')),
        key: textOrNull(cell(row, 'key')),
        value: textOrNull(cell(row, 'value')),
      })),
    );
    if (result.rows.length < LINK_DIRECTORY_PAGE_SIZE && !result.truncated) {
      return linkDirectoryOf(rows);
    }
  }
}

/** The open projects tied to the meeting's people and companies, one per tie. */
export async function loadProjectTies({
  index,
  meeting,
  entities,
}: {
  index: Pick<IndexPort, 'query'>;
  meeting: VaultPath;
  entities: readonly VaultPath[];
}): Promise<ProjectTie[]> {
  if (entities.length === 0) return [];
  const { sql, parameters } = compileProjectTiesQuery({ meeting, entities });
  const result = await index.query(sql, parameters);
  const cell = cellsOf(result);
  return result.rows.map((row) => ({
    project: createVaultPath(String(cell(row, 'project'))),
    title: String(cell(row, 'title') ?? ''),
    entity: createVaultPath(String(cell(row, 'entity'))),
  }));
}

/** The people and companies a meeting links in its `people` and `companies`, as the index resolved them. */
export async function loadMeetingEntities({
  index,
  meeting,
}: {
  index: Pick<IndexPort, 'query'>;
  meeting: VaultPath;
}): Promise<VaultPath[]> {
  const { sql, parameters } = compileMeetingEntitiesQuery(meeting);
  const result = await index.query(sql, parameters);
  const cell = cellsOf(result);
  return result.rows.map((row) => createVaultPath(String(cell(row, 'entity'))));
}

function cellsOf(result: QueryResult) {
  return (row: readonly unknown[], name: string): unknown => row[result.columns.indexOf(name)];
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
