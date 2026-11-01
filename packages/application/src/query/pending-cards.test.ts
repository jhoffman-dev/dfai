/**
 * #260: a card dropped on a board is drawn where the move puts it at once,
 * before its write lands and the index reads it back.
 */

import { describe, expect, it } from 'vitest';
import type { BoardRow, StatusProperty } from '@dfai/domain';
import { cardAsMoved, resultAsPending, rowsAsPending, type PendingCard } from './pending-cards.ts';

const STATUS: StatusProperty = {
  key: 'status',
  done: 'done',
  options: ['backlog', 'doing', 'done'],
};

/** A weekly task in play, as the board's query read it. */
const REPEATING = { status: 'doing', due: '2026-01-05', recurrence: 'every week' };

const row = (path: string, values: Record<string, unknown>): BoardRow => ({
  path,
  title: path.replace('.md', ''),
  values: { path, title: path.replace('.md', ''), ...values },
});

describe('cardAsMoved', () => {
  it('reads as the column it was dropped in, spelled as the column holds it', () => {
    expect(
      cardAsMoved({
        values: { status: 'backlog', project: '[[DFAI]]' },
        move: {
          column: { key: 'project', value: '[[Garden]]', kind: 'relation' },
          lane: null,
          status: STATUS,
          columnOptions: [],
        },
      }),
    ).toEqual({ project: '[[Garden]]' });
  });

  it('reads as the column and the lane together', () => {
    expect(
      cardAsMoved({
        values: { status: 'backlog', area: 'home' },
        move: {
          column: { key: 'area', value: 'work' },
          lane: { key: 'status', value: 'doing' },
          status: STATUS,
          columnOptions: ['home', 'work'],
        },
      }),
    ).toEqual({ area: 'work', status: 'doing' });
  });

  it('reads as done when an ordinary task is dropped on done', () => {
    expect(
      cardAsMoved({
        values: { status: 'doing', due: '2026-01-05' },
        move: {
          column: { key: 'status', value: 'done' },
          lane: null,
          status: STATUS,
          columnOptions: STATUS.options,
        },
      }),
    ).toEqual({ status: 'done' });
  });

  it('reads as where the roll puts a repeating task dropped on done: back in play, due next time', () => {
    expect(
      cardAsMoved({
        values: REPEATING,
        move: {
          column: { key: 'status', value: 'done' },
          lane: null,
          status: STATUS,
          columnOptions: STATUS.options,
        },
      }),
    ).toEqual({ status: 'backlog', due: '2026-01-12' });
  });

  it('keeps the column a repeating task was dropped in when its lane finishes it', () => {
    expect(
      cardAsMoved({
        values: { ...REPEATING, area: 'home' },
        move: {
          column: { key: 'area', value: 'work' },
          lane: { key: 'status', value: 'done' },
          status: STATUS,
          columnOptions: ['home', 'work'],
        },
      }),
    ).toEqual({ area: 'work', status: 'backlog', due: '2026-01-12' });
  });

  it('reads as no value for a card dropped in the column of cards with none', () => {
    expect(
      cardAsMoved({
        values: { area: 'home' },
        move: {
          column: { key: 'area', value: null },
          lane: null,
          status: null,
          columnOptions: ['home'],
        },
      }),
    ).toEqual({ area: null });
  });
});

describe('rowsAsPending', () => {
  const ROWS = [row('One.md', { status: 'backlog' }), row('Two.md', { status: 'doing' })];
  const read = { at: 5, indexKey: 'ready:5' };

  it('is the rows themselves while nothing is being written', () => {
    expect(rowsAsPending({ rows: ROWS, pending: [], read })).toBe(ROWS);
  });

  it('draws a card being written as it was moved, and every other card as the object it was', () => {
    const pending: PendingCard[] = [{ path: 'One.md', values: { status: 'done' }, landed: null }];
    const shown = rowsAsPending({ rows: ROWS, pending, read });
    expect(shown[0]?.values).toMatchObject({ path: 'One.md', status: 'done' });
    expect(shown[0]?.title).toBe('One');
    expect(shown[1]).toBe(ROWS[1]);
  });

  it('keeps drawing a written card as moved through a read begun before it landed (#121)', () => {
    const pending: PendingCard[] = [
      { path: 'One.md', values: { status: 'done' }, landed: { at: 5, indexKey: 'ready:4' } },
    ];
    const shown = rowsAsPending({ rows: ROWS, pending, read });
    expect(shown[0]?.values['status']).toBe('done');
  });

  it('keeps drawing it as moved through a read of an index that has not moved since (#239)', () => {
    const pending: PendingCard[] = [
      { path: 'One.md', values: { status: 'done' }, landed: { at: 4, indexKey: 'ready:5' } },
    ];
    expect(rowsAsPending({ rows: ROWS, pending, read })[0]?.values['status']).toBe('done');
  });

  it('draws the card as the index has it once a read since has caught up with the write', () => {
    const pending: PendingCard[] = [
      { path: 'One.md', values: { status: 'done' }, landed: { at: 4, indexKey: 'ready:4' } },
    ];
    expect(rowsAsPending({ rows: ROWS, pending, read })).toBe(ROWS);
  });

  it('draws the card as its latest move put it, when it was moved twice', () => {
    const pending: PendingCard[] = [
      { path: 'One.md', values: { status: 'doing' }, landed: null },
      { path: 'One.md', values: { status: 'done' }, landed: null },
    ];
    expect(rowsAsPending({ rows: ROWS, pending, read })[0]?.values['status']).toBe('done');
  });

  it('lays a second move over the first: what the first alone changed is still drawn', () => {
    const pending: PendingCard[] = [
      { path: 'One.md', values: { status: 'backlog', due: '2026-01-12' }, landed: null },
      { path: 'One.md', values: { status: 'doing' }, landed: null },
    ];
    expect(rowsAsPending({ rows: ROWS, pending, read })[0]?.values).toMatchObject({
      status: 'doing',
      due: '2026-01-12',
    });
  });

  it('is the rows themselves when the card being written is not among them', () => {
    const pending: PendingCard[] = [{ path: 'Gone.md', values: { status: 'done' }, landed: null }];
    expect(rowsAsPending({ rows: ROWS, pending, read })).toBe(ROWS);
  });
});

describe('resultAsPending (#300)', () => {
  const READ = { at: 1, indexKey: 'ready:1' };
  const result = {
    columns: ['path', 'title', 'status', 'phase'],
    rows: [
      ['one.md', 'One', 'backlog', 1],
      ['two.md', 'Two', 'doing', 2],
    ],
  };
  const edited = (values: Record<string, unknown>, landed: PendingCard['landed'] = null) => ({
    path: 'one.md',
    values,
    landed,
  });

  it('draws a cell committed and not yet read back as committed', () => {
    const shown = resultAsPending({ result, pending: [edited({ status: 'done' })], read: READ });
    expect(shown.rows[0]).toEqual(['one.md', 'One', 'done', 1]);
  });

  it('leaves every other row the object it was, so only the edited row draws again', () => {
    const shown = resultAsPending({ result, pending: [edited({ status: 'done' })], read: READ });
    expect(shown.rows[1]).toBe(result.rows[1]);
    expect(shown.columns).toBe(result.columns);
  });

  it('is the result itself while nothing is pending', () => {
    expect(resultAsPending({ result, pending: [], read: READ })).toBe(result);
  });

  it('lets a cell go once a read stands for its write', () => {
    const landed = { at: 1, indexKey: 'ready:1' };
    const later = { at: 2, indexKey: 'ready:2' };
    const shown = resultAsPending({
      result,
      pending: [edited({ status: 'done' }, landed)],
      read: later,
    });
    expect(shown).toBe(result);
  });

  it('ignores a pending value for a column the result does not carry', () => {
    const shown = resultAsPending({ result, pending: [edited({ owner: 'x' })], read: READ });
    expect(shown.rows[0]).toEqual(result.rows[0]);
  });
});
