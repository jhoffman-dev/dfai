import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseObjectType } from '../types/property-def.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { typeViewSelectSql, type TypeViewSpec } from './type-view.ts';

/**
 * The index's own tests (apps/desktop/src-tauri/src/index.rs) hold SQL that
 * TypeScript writes: the query budget tests (#143) run DFAI queries "as
 * compileAtlasQuery compiles them", and the type views are built to
 * `typeViewSelectSql`'s text. Copied by hand, that SQL went stale when the
 * query language changed (follow-up to #110), so the budgets measured SQL
 * that no longer ships. Here each copy is held to what TypeScript writes now.
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
  parseObjectType({ name: 'project', properties: {} }),
  parseObjectType({
    name: 'task',
    properties: {
      status: { kind: 'select', options: ['next', 'waiting', 'done'] },
      due: 'date',
      waiting_on: { kind: 'relation', target: 'person' },
    },
  }),
];

const compiled = (text: string) =>
  compileAtlasQuery(parseAtlasQuery(text), {
    types: TYPES,
    resolveLink: () => null,
    thisNote: 'people/Mara Quill.md',
  }).sql;

const BUDGET_QUERIES: Readonly<Record<string, string>> = {
  LINKED_NOTES_OF_A_PERSON:
    'FROM meeting, person, project WHERE CONNECTED TO this AND NOT (type = meeting AND attendees = this) SORT BY modified DESC SHOW title LIMIT 202',
  MEETINGS_LINKING_TO_THIS: 'FROM meeting WHERE LINKS TO this',
  MEETINGS_CONNECTED_TO_THIS: 'FROM meeting WHERE CONNECTED TO this',
  MEETINGS_WITH_AN_ATTENDEE_CONNECTED_TO_THIS: 'FROM meeting WHERE attendees CONNECTED TO this',
  OPEN_TASKS_OF_A_PERSON:
    'FROM task WHERE CONNECTED TO this AND status != done AND NOT (status = waiting AND waiting_on = this) SORT BY due, title GROUP BY status SHOW due LIMIT 202',
};

describe("the index's query budgets run the SQL a DFAI query compiles to", () => {
  it.each(Object.entries(BUDGET_QUERIES))(
    '%s is %s, as compileAtlasQuery writes it',
    (name, query) => {
      expect(rustConstant(name)).toBe(compiled(query));
    },
  );

  it("NOTES_OF_A_TYPE asks of each note what every query's FROM asks", () => {
    const asked =
      /const NOTES_OF_A_TYPE: &str = "[\s\S]*?(WHERE EXISTS \(SELECT 1 FROM props AS t[\s\S]*?IN \(\?\)\))/.exec(
        INDEX_RS,
      )?.[1];
    expect(asked?.replace(/\s+/g, ' ')).toBe(
      /WHERE EXISTS \(SELECT 1 FROM props AS t[^\n]*\)\)/.exec(compiled('FROM task'))?.[0],
    );
  });
});

/** Every kind a view column can be, single and many. */
export const PINNED_VIEW: TypeViewSpec = {
  name: 'task',
  columns: [
    { key: 'status', kind: 'select', many: false },
    { key: 'due', kind: 'date', many: false },
    { key: 'estimate', kind: 'number', many: false },
    { key: 'contexts', kind: 'multiSelect', many: false },
    { key: 'project', kind: 'relation', many: false },
    { key: 'flagged', kind: 'checkbox', many: false },
    { key: 'dates', kind: 'date', many: true },
    { key: 'sizes', kind: 'number', many: true },
  ],
  progress: true,
};

describe("the index's type views are typeViewSelectSql's text", () => {
  it('VIEW_OF_A_TYPE, the view index.rs builds for this spec, is what TypeScript describes', () => {
    expect(rustConstant('VIEW_OF_A_TYPE')).toBe(typeViewSelectSql(PINNED_VIEW));
  });
});
