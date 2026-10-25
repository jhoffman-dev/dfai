/**
 * #31 through the local API: a day's meetings from Google Calendar
 * (ADR-0046), read-only. `GET /v1/calendar/meetings?day=` answers what the
 * Today page lists, from the event notes a meetings sync wrote, and never
 * asks Google or writes anything.
 */

import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { toIndexedNote } from '../index/to-indexed-note.ts';
import type { IndexPort } from '../index/ports.ts';
import { apiFixture, bodyOf, codeOf, OTHER_VAULT } from '../testing/api-fixture.ts';
import { jsonMarkdown } from '../testing/json-markdown.ts';
import { sqliteIndexPort } from '../testing/sqlite-index.ts';

const DAY = '2026-10-24';

const note = (properties: Record<string, unknown>) =>
  `---\n${JSON.stringify(properties)}\n---\n\nPrep notes.\n`;

const event = (properties: Record<string, unknown>) =>
  note({ type: 'event', gcal_calendar: 'primary', gcal_response: 'accepted', ...properties });

const FILES: Record<string, string> = {
  'People/Mara Quill.md': note({ type: 'person', email: 'mara@larkspur.example' }),
  'Calendar/2026-10-24 Payroll standup.md': event({
    title: 'Payroll standup',
    date: '2026-10-24T09:00',
    ends: '2026-10-24T09:30',
    gcal_event_id: 'ev-standup',
    people: ['[[People/Mara Quill]]'],
  }),
  'Calendar/2026-10-24 Vendor review.md': event({
    title: 'Vendor review',
    date: '2026-10-24T08:00',
    ends: '2026-10-25T01:00',
    gcal_event_id: 'ev-vendor',
    gcal_response: 'tentative',
  }),
  'Calendar/2026-10-24 Declined sync.md': event({
    title: 'Declined sync',
    date: '2026-10-24T11:00',
    gcal_event_id: 'ev-declined',
    gcal_response: 'declined',
  }),
  'Calendar/2026-10-24 Cancelled lunch.md': event({
    title: 'Cancelled lunch',
    date: '2026-10-24T12:00',
    gcal_event_id: 'ev-cancelled',
    gcal_missing: true,
  }),
  'Calendar/2026-10-24 Offsite.md': event({
    title: 'Offsite',
    date: '2026-10-24',
    gcal_event_id: 'ev-allday',
  }),
  'Calendar/2026-10-25 Tomorrow.md': event({
    title: 'Tomorrow',
    date: '2026-10-25T09:00',
    gcal_event_id: 'ev-tomorrow',
  }),
};

/** A real SQLite index holding `files`, as the host's index would. */
async function indexOf(files: Record<string, string>): Promise<IndexPort> {
  const index = sqliteIndexPort();
  const markdown = jsonMarkdown();
  const notePaths = Object.keys(files).map(createVaultPath);
  await index.put(
    Object.entries(files).map(([path, text]) =>
      toIndexedNote({ file: { path, text, modified: 1, size: text.length }, notePaths, markdown }),
    ),
  );
  return index;
}

const get = (api: ReturnType<typeof apiFixture>, query: Record<string, string>) =>
  api.send({ method: 'GET', path: '/v1/calendar/meetings', query });

describe('GET /v1/calendar/meetings', () => {
  it('answers the day’s timed meetings earliest first, with their links and answer', async () => {
    const api = apiFixture({ index: await indexOf(FILES) });
    const response = await get(api, { day: DAY });

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      day: DAY,
      meetings: [
        {
          path: 'Calendar/2026-10-24 Vendor review.md',
          title: 'Vendor review',
          start: '08:00',
          end: null,
          people: [],
          companies: [],
          meeting: null,
          unanswered: true,
        },
        {
          path: 'Calendar/2026-10-24 Payroll standup.md',
          title: 'Payroll standup',
          start: '09:00',
          end: '09:30',
          people: ['People/Mara Quill.md'],
          companies: [],
          meeting: null,
          unanswered: false,
        },
      ],
    });
  });

  it('leaves out declined and cancelled meetings, all-day events and other days', async () => {
    const api = apiFixture({ index: await indexOf(FILES) });
    const body = JSON.stringify(bodyOf(await get(api, { day: DAY })));
    for (const title of ['Declined sync', 'Cancelled lunch', 'Offsite', 'Tomorrow']) {
      expect(body).not.toContain(title);
    }
  });

  it('answers no meetings for a day with none', async () => {
    const api = apiFixture({ index: await indexOf(FILES) });
    expect(bodyOf(await get(api, { day: '2026-11-02' }))).toEqual({
      day: '2026-11-02',
      meetings: [],
    });
  });

  it('refuses a missing day, one that does not exist, and one with a time', async () => {
    const api = apiFixture({ index: await indexOf(FILES) });
    for (const query of [
      {},
      { day: '2026-02-30' },
      { day: '2026-10-24T09:00' },
      { day: 'today' },
    ]) {
      const response = await get(api, query);
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(codeOf(response), JSON.stringify(query)).toBe('invalid');
    }
  });

  it('writes nothing', async () => {
    const api = apiFixture({ index: await indexOf(FILES) });
    await get(api, { day: DAY });
    expect(api.writes).toEqual([]);
  });

  it('fails as query_failed, never answering no meetings, when the index cannot be read', async () => {
    const api = apiFixture({
      index: {
        query: async () => {
          throw new Error('index closed');
        },
      },
    });
    expect(codeOf(await get(api, { day: DAY }))).toBe('query_failed');
  });

  it('answers no_vault when the vault is switched while the meetings are read', async () => {
    const api = apiFixture({ index: await indexOf(FILES) });
    const query = api.deps.index.query;
    api.deps = {
      ...api.deps,
      index: {
        ...api.deps.index,
        query: async (...args) => {
          api.open = OTHER_VAULT;
          return query(...args);
        },
      },
    };
    expect(codeOf(await get(api, { day: DAY }))).toBe('no_vault');
  });
});
