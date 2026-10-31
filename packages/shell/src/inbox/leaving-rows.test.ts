import { describe, expect, it } from 'vitest';
import { createVaultPath, type InboxItem } from '@dfai/domain';
import type { InboxListing } from '@dfai/application';
import { withoutLeaving, type LeavingRow } from './leaving-rows.ts';

const item = (title: string): InboxItem =>
  ({ path: createVaultPath(`Inbox/${title}.md`), title }) as unknown as InboxItem;

const listing = (...titles: string[]): InboxListing => ({
  items: titles.map(item),
  truncated: false,
  total: titles.length + 10,
  last: null,
});

const titles = (shown: InboxListing) => shown.items.map((each) => each.title);
const path = (title: string) => createVaultPath(`Inbox/${title}.md`);

describe('withoutLeaving (#217)', () => {
  it('keeps a row being written off the list, and counts it out of the total', () => {
    const rows: LeavingRow[] = [{ path: path('Call Mara'), settled: null }];
    const shown = withoutLeaving(listing('Call Mara', 'Pay Tobias'), rows, {
      at: 9,
      indexKey: 'ready:9',
    });
    expect(titles(shown)).toEqual(['Pay Tobias']);
    expect(shown.total).toBe(11);
  });

  it('keeps a written row off what a read begun before its write ended found', () => {
    const rows: LeavingRow[] = [
      { path: path('Call Mara'), settled: { at: 5, indexKey: 'ready:3' } },
    ];
    const read = { at: 4, indexKey: 'ready:4' };
    expect(titles(withoutLeaving(listing('Call Mara', 'Pay Tobias'), rows, read))).toEqual([
      'Pay Tobias',
    ]);
  });

  it('keeps it off a read begun after, while the index has not moved on since the write', () => {
    const rows: LeavingRow[] = [
      { path: path('Call Mara'), settled: { at: 5, indexKey: 'ready:3' } },
    ];
    const read = { at: 6, indexKey: 'ready:3' };
    expect(titles(withoutLeaving(listing('Call Mara'), rows, read))).toEqual([]);
  });

  it('shows what the index says once it has moved on: a row still listed is still waiting', () => {
    const rows: LeavingRow[] = [
      { path: path('Call Mara'), settled: { at: 5, indexKey: 'ready:3' } },
    ];
    const read = { at: 6, indexKey: 'ready:4' };
    const shown = withoutLeaving(listing('Call Mara', 'Pay Tobias'), rows, read);
    expect(titles(shown)).toEqual(['Call Mara', 'Pay Tobias']);
    expect(shown.total).toBe(12);
  });

  it('hands back the listing itself when nothing has left it', () => {
    const shown = listing('Pay Tobias');
    expect(withoutLeaving(shown, [], { at: 1, indexKey: 'ready:1' })).toBe(shown);
  });
});
