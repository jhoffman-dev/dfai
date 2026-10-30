/**
 * Attack on PR #602 (#108): the planning tray's chosen tasks must be the
 * ones the Today page lists under Chosen for today — run for real against
 * SQLite, as plan-tray.test.ts does.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { BLOCK_TYPE_FILE, TASK_TYPE_FILE } from '@dfai/domain';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import { readPlanTray } from './plan-tray.ts';

const TYPES = [TASK_TYPE_FILE.type, BLOCK_TYPE_FILE.type];

const indexOf = (notes: Record<string, unknown>) => {
  const files = Object.fromEntries(
    Object.entries(notes).map(([path, frontmatter]) => [path, jsonNote(frontmatter)]),
  );
  return fakeIndexPort({ query: atlasQueryIndex({ files, markdown: jsonMarkdown() }) });
};

/** SQLite's own `@today`, shifted by `days`. */
function sqliteDay(days = 0): string {
  const db = new DatabaseSync(':memory:');
  const row = db.prepare(`SELECT date('now', 'localtime', '${days} days') AS day`).get() as {
    day: string;
  };
  db.close();
  return row.day;
}

const trayOf = async (notes: Record<string, unknown>) =>
  (await readPlanTray({ index: indexOf(notes), types: TYPES, notePaths: Object.keys(notes) })).map(
    (each) => [each.title, each.chosen],
  );

describe('the planning tray against Today’s Chosen for today (#108)', () => {
  it('leaves out a chosen task deferred to a later day, which Today hides', async () => {
    const tray = await trayOf({
      'Paint the shed.md': {
        type: 'task',
        status: 'next-action',
        focus: sqliteDay(),
        defer: sqliteDay(3),
      },
    });

    expect(tray).toEqual([]);
  });

  it('lists a chosen task whose focus carries a time, as Today does', async () => {
    const tray = await trayOf({
      'Paint the shed.md': { type: 'task', status: 'next-action', focus: `${sqliteDay()}T09:00` },
    });

    expect(tray).toEqual([['Paint the shed', true]]);
  });

  it('lists a chosen task with no status, which Today lists under Chosen', async () => {
    const tray = await trayOf({
      'Paint the shed.md': { type: 'task', focus: sqliteDay() },
    });

    expect(tray).toEqual([['Paint the shed', true]]);
  });
});
