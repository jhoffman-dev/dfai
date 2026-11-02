import { describe, expect, it } from 'vitest';
import {
  LINK_HINTS_PAGE_SIZE,
  LINK_HINTS_QUERY_COLUMNS,
  LINK_HINTS_QUERY_MARK,
} from '@dfai/domain';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import { readLinkHints } from './link-hints.ts';

/** An index answering every part with `rows` (each part keeps its own kind), a page at a time. */
const answering = (rows: unknown[][], columns: readonly string[] = LINK_HINTS_QUERY_COLUMNS) => {
  const asked: string[] = [];
  const index = fakeIndexPort({
    query: async (sql, parameters) => {
      asked.push(sql);
      const [limit, offset] = parameters.slice(-2).map(Number) as [number, number];
      return {
        columns: [...columns],
        rows: rows.slice(offset, offset + limit),
        truncated: false,
      };
    },
  });
  return { index, asked };
};

describe('readLinkHints', () => {
  it('reads the notes, their aliases and their use, each part once when it fits a page', async () => {
    const { index, asked } = answering([
      ['note', 'People/Mara Quill.md', 'Mara Quill', null, null],
      ['note', 'People/Tobias Fenn.md', 'Tobias Fenn', null, null],
      ['alias', 'People/Mara Quill.md', 'MQ', null, null],
      ['alias', 'People/Mara Quill.md', 'Mara', null, null],
      ['use', 'People/Tobias Fenn.md', null, 3, 1700],
    ]);
    const read = await readLinkHints({ index });
    expect(asked).toHaveLength(3);
    expect(asked.every((sql) => sql.startsWith(LINK_HINTS_QUERY_MARK))).toBe(true);
    expect(read.notes).toEqual([
      { path: 'People/Mara Quill.md', title: 'Mara Quill' },
      { path: 'People/Tobias Fenn.md', title: 'Tobias Fenn' },
    ]);
    expect(read.hints.aliases.get('People/Mara Quill.md')).toEqual(['MQ', 'Mara']);
    expect(read.hints.uses.get('People/Tobias Fenn.md')).toEqual({ count: 3, last: 1700 });
  });

  it('reads a use whose notes the index cannot date as undated, not as the epoch (ADR-0053)', async () => {
    const { index } = answering([['use', 'People/Tobias Fenn.md', null, 2, null]]);
    const read = await readLinkHints({ index });
    expect(read.hints.uses.get('People/Tobias Fenn.md')).toEqual({ count: 2, last: null });
  });

  it('reads on, a page at a time, until a page comes back short: none past the first page is lost', async () => {
    const notes = Array.from({ length: LINK_HINTS_PAGE_SIZE + 2 }, (_, at) => [
      'note',
      `Notes/${String(at).padStart(5, '0')}.md`,
      `Note ${at}`,
      null,
      null,
    ]);
    const { index, asked } = answering(notes);
    const read = await readLinkHints({ index });
    expect(read.notes).toHaveLength(LINK_HINTS_PAGE_SIZE + 2);
    // Two pages for each of the three parts: the fake answers every part from the same rows.
    expect(asked).toHaveLength(6);
  });

  it('refuses an answer the index says it cut short, rather than pass it off as all there is', async () => {
    const index = fakeIndexPort({
      query: async () => ({ columns: [...LINK_HINTS_QUERY_COLUMNS], rows: [], truncated: true }),
    });
    await expect(readLinkHints({ index })).rejects.toThrow('cut its answer short');
  });

  it('leaves out a file that is not a note', async () => {
    const { index } = answering([
      ['note', 'Larkspur Payroll.md', 'Larkspur Payroll', null, null],
      ['note', 'assets/logo.png', 'logo.png', null, null],
    ]);
    expect((await readLinkHints({ index })).notes).toEqual([
      { path: 'Larkspur Payroll.md', title: 'Larkspur Payroll' },
    ]);
  });

  it('finds its columns by name, whatever order they come back in', async () => {
    const { index } = answering(
      [[1700, 2, null, 'People/Tobias Fenn.md', 'use']],
      ['last', 'uses', 'text', 'path', 'kind'],
    );
    const read = await readLinkHints({ index });
    expect(read.hints.uses.get('People/Tobias Fenn.md')).toEqual({ count: 2, last: 1700 });
  });

  it('skips a row it cannot read rather than offering nonsense', async () => {
    const { index } = answering([
      ['note', null, 'No path', null, null],
      ['alias', 'a.md', 42, null, null],
      ['use', 'b.md', null, 'many', null],
      ['other', 'c.md', 'x', null, null],
    ]);
    const read = await readLinkHints({ index });
    expect(read.notes).toEqual([]);
    expect(read.hints.aliases.size).toBe(0);
    expect(read.hints.uses.size).toBe(0);
  });

  it('passes on an index that cannot answer', async () => {
    const index = fakeIndexPort({
      query: async () => {
        throw new Error('The index is not open.');
      },
    });
    await expect(readLinkHints({ index })).rejects.toThrow('The index is not open.');
  });
});
