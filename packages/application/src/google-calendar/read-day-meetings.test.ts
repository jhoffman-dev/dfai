import { describe, expect, it } from 'vitest';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import { readDayMeetings, DAY_MEETINGS_SCOPE } from './read-day-meetings.ts';

describe('readDayMeetings', () => {
  it('reads the index’s rows by their column names, an empty cell as nothing', async () => {
    const index = fakeIndexPort({
      query: async () => ({
        // Columns in another order than the query names them, as a host may hand them back.
        columns: ['value', 'key', 'title', 'path'],
        rows: [
          ['2026-10-24T09:00', 'date', null, 'Calendar/Untitled.md'],
          [null, 'ends', null, 'Calendar/Untitled.md'],
          [undefined, 'gcal_response', null, 'Calendar/Untitled.md'],
        ],
        truncated: false,
      }),
    });
    expect(await readDayMeetings({ index, day: '2026-10-24' })).toEqual([
      {
        path: 'Calendar/Untitled.md',
        title: '',
        start: '09:00',
        end: null,
        people: [],
        companies: [],
        meeting: null,
        unanswered: false,
      },
    ]);
  });

  it('is read again for news of event notes and of the folder they are made in', () => {
    expect(DAY_MEETINGS_SCOPE).toEqual({ types: ['event'], folders: ['Calendar'] });
  });
});
