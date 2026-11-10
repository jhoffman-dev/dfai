/**
 * Writes through the local API and MCP in the Activity log (U-28): one line
 * each, by route and note, never by what the request carried; reads are not
 * logged at all.
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, encoded, OTHER_VAULT } from '../testing/api-fixture.ts';

const NOTE = '---\nstatus: todo\n---\n\n# Call Sam\n\nAbout the lease.\n';
const CARRIED = 'a body the log must never hold';

const vault = () => apiFixture({ files: { 'Tasks/Call.md': NOTE } });
const modifiedOf = (api: ReturnType<typeof vault>) => api.files.get('Tasks/Call.md')?.modified;
const CALL = encoded('Tasks/Call.md');

describe('a write through the API', () => {
  it('is recorded by its route and note, and never by its body', async () => {
    const api = vault();
    const response = await api.send({
      method: 'PUT',
      path: `/v1/notes/${CALL}/body`,
      body: { markdown: CARRIED, ifModified: modifiedOf(api) },
    });
    expect(response.status).toBe(200);
    expect(api.activity.reports).toEqual([
      {
        level: 'info',
        kind: 'api',
        message: 'PUT v1/notes/{path}/body — Call',
        subject: { kind: 'note', path: 'Tasks/Call.md' },
      },
    ]);
    expect(JSON.stringify(api.activity.reports)).not.toContain(CARRIED);
  });

  it('records a note it made by the path it answered with', async () => {
    const api = vault();
    const response = await api.send({ method: 'POST', path: '/v1/notes', body: { name: 'Plan' } });
    expect(response.status).toBe(201);
    expect(api.activity.reports).toEqual([
      {
        level: 'info',
        kind: 'api',
        message: 'POST v1/notes — Plan',
        subject: { kind: 'note', path: 'Plan.md' },
      },
    ]);
  });

  it('records a refused write as a warning, with its code and reason and not its body', async () => {
    const api = vault();
    const response = await api.send({
      method: 'POST',
      path: `/v1/notes/${CALL}/append`,
      body: { markdown: CARRIED, ifModified: 1 },
    });
    expect(response.status).toBe(409);
    expect(api.activity.reports).toEqual([
      {
        level: 'warning',
        kind: 'api',
        message:
          'POST v1/notes/{path}/append refused for Call (conflict): Tasks/Call.md changed since you read it',
        subject: { kind: 'note', path: 'Tasks/Call.md' },
        detail: 'Tasks/Call.md changed since you read it',
      },
    ]);
    expect(JSON.stringify(api.activity.reports)).not.toContain(CARRIED);
  });

  describe('a refused meeting, with the reason it was told (#814)', () => {
    const MEETING = { provider: 'gemini', sourceId: 'fake-0814', title: 'Garden club sync' };
    const refusedMeeting = async (api: ReturnType<typeof vault>, body: object) => {
      await api.send({ method: 'POST', path: '/v1/meetings', body });
      expect(api.activity.reports).toHaveLength(1);
      return api.activity.reports[0];
    };

    it('names a field it does not read, and not what the field carried', async () => {
      const report = await refusedMeeting(vault(), { ...MEETING, transcriptMD: CARRIED });
      expect(report).toEqual({
        level: 'warning',
        kind: 'api',
        message: 'POST v1/meetings refused (invalid): "transcriptMD" is not a field of a meeting',
        subject: null,
        detail: '"transcriptMD" is not a field of a meeting',
      });
      expect(JSON.stringify(report)).not.toContain(CARRIED);
    });

    it('names a field it needs and was not sent', async () => {
      const { provider, sourceId } = MEETING;
      const report = await refusedMeeting(vault(), { provider, sourceId, summaryMd: CARRIED });
      expect(report?.message).toBe('POST v1/meetings refused (invalid): title must be a string');
      expect(report?.detail).toBe('title must be a string');
      expect(JSON.stringify(report)).not.toContain(CARRIED);
    });

    it('says only that DFAI could not answer when the fault was its own', async () => {
      const api = vault();
      api.deps = {
        ...api.deps,
        fs: {
          ...api.deps.fs,
          readNotes: async () => {
            throw new Error('disk I/O error at /Users/sam/Vault/.atlas/settings.json');
          },
        },
      };
      const report = await refusedMeeting(api, { ...MEETING, summaryMd: CARRIED });
      expect(report?.message).toBe(
        'POST v1/meetings refused (internal): DFAI could not answer this request',
      );
      expect(report?.detail).toBe('DFAI could not answer this request');
      expect(JSON.stringify(report)).not.toMatch(/disk I\/O|\/Users|settings\.json/);
      expect(JSON.stringify(report)).not.toContain(CARRIED);
    });
  });

  it('records a refusal whose path would not decode, with no link', async () => {
    const api = vault();
    await api.send({ method: 'PUT', path: '/v1/notes/%E0%A4/body', body: { markdown: 'x' } });
    expect(api.activity.reports).toHaveLength(1);
    expect(api.activity.reports[0]).toMatchObject({ level: 'warning', subject: null });
  });

  it('records a write that made nothing new only when it made something', async () => {
    const api = vault();
    const first = await api.send({ method: 'POST', path: '/v1/daily' });
    const again = await api.send({ method: 'POST', path: '/v1/daily' });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(api.activity.reports).toHaveLength(1);
    expect(api.activity.reports[0]?.message).toMatch(/^POST v1\/daily — /);
  });

  it('records nothing when it was refused for want of its vault', async () => {
    const api = vault();
    api.open = null;
    const response = await api.send({
      method: 'PUT',
      path: `/v1/notes/${CALL}/body`,
      body: { markdown: 'x', ifModified: 1 },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(api.activity.reports).toEqual([]);
  });

  it('records nothing for a write cut off by another vault opening', async () => {
    const api = vault();
    const reading = api.deps.fs.readTextFile;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        readTextFile: async (path) => {
          const read = await reading(path);
          api.open = OTHER_VAULT;
          return read;
        },
      },
    };
    const response = await api.send({
      method: 'PUT',
      path: `/v1/notes/${CALL}/body`,
      body: { markdown: 'x', ifModified: modifiedOf(api) },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(api.activity.reports).toEqual([]);
  });
});

describe('a read through the API', () => {
  it('is not recorded, even one asked with POST', async () => {
    const api = vault();
    const read = await api.send({ method: 'GET', path: `/v1/notes/${CALL}` });
    const status = await api.send({ method: 'GET', path: '/v1/status' });
    const query = await api.send({
      method: 'POST',
      path: '/v1/query',
      body: { type: 'task' },
    });
    const missing = await api.send({ method: 'GET', path: '/v1/nope' });
    expect([read.status, status.status]).toEqual([200, 200]);
    expect(query.status).toBeGreaterThan(0);
    expect(missing.status).toBe(404);
    expect(api.activity.reports).toEqual([]);
  });
});
