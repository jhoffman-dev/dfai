/**
 * #192 through the API: the "After a meeting" rule's dry run names the
 * meetings whose linking failed, which Run now links again first; it writes
 * nothing, and says nothing of them for a rule that does not link meetings.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, encoded } from '../testing/api-fixture.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';

const STANDUP = 'Inbox/Meetings/2026-10-06 Standup.md';
const KICKOFF = 'Inbox/Meetings/2026-10-06 Kickoff.md';

const after = (fields: Record<string, unknown> = {}) =>
  jsonNote({
    atlas: 'automation',
    enabled: true,
    id: 'after',
    name: 'After a meeting',
    when: 'a meeting is created',
    which: 'FROM meeting',
    do: 'claude',
    prompt: '.atlas/prompts/after-a-meeting.md',
    output: 'meeting-items',
    apply: 'mine',
    ...fields,
  });
const meeting = (fields: Record<string, unknown> = {}) =>
  jsonNote({
    type: 'meeting',
    atlas_import: 'meeting/v1',
    provider: 'gemini',
    atlas_import_outcome: 'imported',
    date: '2026-10-06',
    ...fields,
  });

function api(rule: string) {
  const files: Record<string, string> = {
    '.atlas/types/meeting.md': jsonNote({
      name: 'meeting',
      label: 'Meeting',
      properties: { date: 'date' },
    }),
    '.atlas/automations/After a meeting.md': rule,
    [STANDUP]: meeting({ atlas_links: 'failed', external_id: 'gemini-1' }),
    [KICKOFF]: meeting({ people: ['[[Mara Quill]]'], external_id: 'gemini-2' }),
  };
  const markdown = jsonMarkdown();
  return apiFixture({ files, markdown, index: { query: atlasQueryIndex({ files, markdown }) } });
}

const dryRun = (fixture: ReturnType<typeof api>) =>
  fixture.send({ method: 'POST', path: `/v1/automations/${encoded('after')}/dry-run` });

describe('POST /v1/automations/{id}/dry-run for the "After a meeting" rule (#192)', () => {
  it('names the meetings not linked, and writes nothing', async () => {
    const fixture = api(after());
    const before = new Map([...fixture.files].map(([path, note]) => [path, note.text]));

    const { plan } = bodyOf(await dryRun(fixture)) as { plan: Record<string, unknown> };

    expect(plan['notLinked']).toEqual({
      meetings: [{ path: STANDUP, title: '2026-10-06 Standup' }],
      capped: false,
    });
    expect(plan['summary']).toContain('1 meeting is not linked: Run now links it first.');
    expect(fixture.writes).toEqual([]);
    expect(new Map([...fixture.files].map(([path, note]) => [path, note.text]))).toEqual(before);
  });

  it('says nothing of them for a Claude step that does not apply', async () => {
    const fixture = api(after({ apply: undefined }));

    const { plan } = bodyOf(await dryRun(fixture)) as { plan: Record<string, unknown> };

    expect(plan['do']).toBe('claude');
    expect(plan).not.toHaveProperty('notLinked');
  });
});
