import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { viewSpecsFor } from '@dfai/application';
import {
  compileViewQuery,
  parseObjectType,
  typeTableQuery,
  typeViewColumns,
  type CompiledQuery,
  type QueryFilter,
  type QueryShape,
} from '@dfai/domain';
import { sqliteWasm } from './in-memory-web-index.ts';

/**
 * Attack on PR #929 (second pass): `is` and `is not` on a list column that
 * most notes of the type do not hold. Each note's single item is counted by
 * its own aggregate lookup, which costs more steps per note than main's
 * empty cell, beyond #929's own bar (10% or 5,000 steps over main).
 */

const root = new URL('../../../../', import.meta.url);
const SCHEMA = readFileSync(new URL('apps/desktop/src-tauri/src/index_schema.sql', root), 'utf8');
const MEETINGS = 5_000;

const MEETING = parseObjectType({
  name: 'meeting',
  properties: {
    title: 'text',
    start: 'text',
    kind: 'text',
    attendees: { kind: 'text', many: true },
    tags: { kind: 'multiSelect', options: [] },
  },
});

/** main's list cell (#921): its held rows, through a CASE. */
const mainView = (select: string) =>
  select.replace(
    /\(SELECT group_concat\(p\.value_text, ', ' ORDER BY p\.idx, p\.rowid\) FROM props AS p WHERE p\.path = n\.path AND p\.key = '(\w+)' AND p\.value_text <> ''\)/g,
    (_, key: string) =>
      `(SELECT group_concat(CASE WHEN p.key = '${key}' THEN p.value_text END, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = '${key}' AND COALESCE(p.value_text, p.value_json, '') <> '')`,
  );

/** Meetings that hold a title, a start and a tag, and no attendees at all. */
async function vaultWithoutAttendees() {
  const sqlite3 = await sqliteWasm();
  const database = new sqlite3.oo1.DB(':memory:');
  database.exec(SCHEMA);
  const file = database.prepare(
    'INSERT INTO files (path, title, summary, modified, size) VALUES (?, ?, ?, ?, 0)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  database.exec('BEGIN');
  for (let at = 0; at < MEETINGS; at += 1) {
    const path = `meetings/Meeting ${at}.md`;
    file.bind([path, `Meeting ${at}`, '', at]).stepReset();
    for (const [key, value] of [
      ['type', 'meeting'],
      ['title', `Weekly sync ${at % 97}`],
      ['start', `09:${String(at % 60).padStart(2, '0')}`],
      ['tags', `t${at % 7}`],
    ] as const)
      prop.bind([path, key, 0, value]).stepReset();
  }
  database.exec('COMMIT');
  file.finalize();
  prop.finalize();
  database.exec('ANALYZE');
  const [spec] = viewSpecsFor([MEETING]);
  const viewAs = (main: boolean) => {
    database.exec('DROP VIEW IF EXISTS "v_meeting"');
    database.exec(
      `CREATE VIEW "v_meeting" AS\n${main ? mainView(spec?.select ?? '') : (spec?.select ?? '')}`,
    );
  };
  const stepsOf = ({ sql, parameters }: CompiledQuery) => {
    const statement = database.prepare(sql);
    statement.bind([...parameters]);
    while (statement.step()) {
      // every row read, as the host reads a page
    }
    const steps = sqlite3.capi.sqlite3_stmt_status(
      statement.pointer as number,
      sqlite3.capi.SQLITE_STMTSTATUS_VM_STEP,
      0,
    );
    statement.finalize();
    return steps;
  };
  const mainAndNew = (filter: QueryFilter, shape: QueryShape) => {
    const query = { ...typeTableQuery(MEETING), filters: [filter] };
    viewAs(true);
    const main = stepsOf(compileViewQuery(query, shape));
    viewAs(false);
    const items = compileViewQuery(query, shape, { viewColumns: typeViewColumns(MEETING) });
    expect(items.sql).toContain('FROM props AS p WHERE p.path = ');
    return { main, now: stepsOf(items) };
  };
  return { mainAndNew, close: () => database.close() };
}

const withinMain = (main: number) => Math.max(main * 1.1, main + 5_000);

const SHAPES: readonly [string, QueryShape][] = [
  ['page', {}],
  ['count', { aggregate: { kind: 'count', column: null } }],
];

describe(`is and is not on a list no meeting holds cost no more than main's, ${MEETINGS} meetings`, () => {
  for (const operator of ['is', 'isNot'] as const) {
    it(`attendees ${operator}, page and count`, async () => {
      const vault = await vaultWithoutAttendees();
      for (const [shaped, shape] of SHAPES) {
        const { main, now } = vault.mainAndNew(
          { key: 'attendees', operator, value: 'mara@example.com' },
          shape,
        );
        expect(now, `${operator}, ${shaped}: ${now} against main's ${main}`).toBeLessThanOrEqual(
          withinMain(main),
        );
      }
      vault.close();
    }, 120_000);
  }
});
