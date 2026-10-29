import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseObjectType } from '../types/property-def.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';

/**
 * The index's own tests (apps/desktop/src-tauri/src/index.rs) hold SQL that
 * TypeScript writes: the query budget tests (#143) run DFAI queries "as
 * compileAtlasQuery compiles them". Copied by hand, that SQL went stale when
 * the query language changed (follow-up to #110), so the budgets measured SQL
 * that no longer ships. Here each copy, and the count of what it binds, is
 * held to what TypeScript writes now.
 */
const root = new URL('../../../../', import.meta.url);
const INDEX_RS = readFileSync(new URL('apps/desktop/src-tauri/src/index.rs', root), 'utf8');

/** A `const NAME: &str = r#"…"#;` in index.rs, as the statement it holds. */
function rustConstant(name: string): string {
  const found = new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`).exec(INDEX_RS);
  if (found?.[1] === undefined) throw new Error(`index.rs has no raw string ${name}`);
  return found[1];
}

/** The types the budget tests' vaults hold, as a person's page reads them. */
const TYPES = [
  parseObjectType({
    name: 'meeting',
    properties: { attendees: { kind: 'relation', target: 'person', many: true } },
  }),
  parseObjectType({ name: 'person', properties: {} }),
  parseObjectType({
    name: 'project',
    properties: { status: { kind: 'select', options: ['doing', 'done'] } },
  }),
  parseObjectType({
    name: 'task',
    properties: {
      status: { kind: 'select', options: ['next', 'waiting', 'done'] },
      due: 'date',
      waiting_on: { kind: 'relation', target: 'person' },
      project: { kind: 'relation', target: 'project' },
    },
  }),
];

const compiledOf = (text: string) =>
  compileAtlasQuery(parseAtlasQuery(text), {
    types: TYPES,
    resolveLink: () => null,
    thisNote: 'people/Mara Quill.md',
  });
const compiled = (text: string) => compiledOf(text).sql;

/** How many values index.rs binds where it runs `name`: the `json!` items after it. */
function rustBound(name: string): number {
  const found = new RegExp(`\\n\\s*${name},\\n\\s*&\\[([\\s\\S]*?)\\n\\s*\\],`).exec(INDEX_RS);
  if (found?.[1] === undefined) throw new Error(`index.rs never runs ${name}`);
  return (found[1].match(/serde_json::json!\(/g) ?? []).length;
}

const BUDGET_QUERIES: Readonly<Record<string, string>> = {
  LINKED_NOTES_OF_A_PERSON:
    'FROM meeting, person, project WHERE CONNECTED TO this AND NOT (type = meeting AND attendees = this) SORT BY modified DESC SHOW title LIMIT 202',
  MEETINGS_LINKING_TO_THIS: 'FROM meeting WHERE LINKS TO this',
  MEETINGS_CONNECTED_TO_THIS: 'FROM meeting WHERE CONNECTED TO this',
  MEETINGS_WITH_AN_ATTENDEE_CONNECTED_TO_THIS: 'FROM meeting WHERE attendees CONNECTED TO this',
  OPEN_TASKS_OF_A_PERSON:
    'FROM task WHERE CONNECTED TO this AND status != done AND NOT (status = waiting AND waiting_on = this) SORT BY due, title GROUP BY status SHOW due LIMIT 202',
  TASKS_BY_THEIR_PROJECTS_STATUS: 'FROM task WHERE project.status = doing LIMIT 5000',
};

describe("the index's query budgets run the SQL a DFAI query compiles to", () => {
  it.each(Object.entries(BUDGET_QUERIES))(
    '%s is %s, as compileAtlasQuery writes it',
    (name, query) => {
      expect(rustConstant(name)).toBe(compiled(query));
      expect(rustBound(name)).toBe(compiledOf(query).parameters.length);
    },
  );

  it("NOTES_OF_A_TYPE asks of each note what every query's FROM asks", () => {
    const pick = /WHERE n\.path IN \(SELECT t\.path FROM props AS t[\s\S]*?IN \(\?\)\)/;
    const rust = /const NOTES_OF_A_TYPE: &str = "([\s\S]*?)";/.exec(INDEX_RS)?.[1] ?? '';
    const asked = pick.exec(rust)?.[0];
    const asks = pick.exec(compiled('FROM task'))?.[0];
    expect(asks).toBeDefined();
    expect(asked?.replace(/\s+/g, ' ')).toBe(asks);
  });
});
