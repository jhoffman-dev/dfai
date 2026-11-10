/**
 * Proposals through the API (P29-02): listed, accepted and rejected by the
 * Inbox's Proposals section's own use-cases, each route naming its vault, writing in
 * user space only, and never saving someone's typing (ADR-0016).
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, encoded, OTHER_VAULT, TODAY } from '../testing/api-fixture.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';

const PROPOSAL = 'Inbox/Proposals/Send the payroll file.md';
const TASK = 'Tasks/2026/09/Send Mara the payroll file.md';

const proposal = (more: Record<string, unknown> = {}, body = '') =>
  jsonLinesNote(
    {
      type: 'proposal',
      kind: 'task',
      confidence: 'high',
      source: '[[2026-10-01 Standup#^t0003]]',
      made_by: 'after-meeting · run 1',
      payload: {
        title: 'Send Mara the payroll file',
        properties: { meeting: '[[2026-10-01 Standup]]' },
      },
      ...more,
    },
    body,
  );

function vault(files: Record<string, string> = {}) {
  return apiFixture({ files: { [PROPOSAL]: proposal(), ...files }, markdown: jsonLinesMarkdown() });
}

const answer = (path: string, verb: 'accept' | 'reject') => ({
  method: 'POST' as const,
  path: `/v1/proposals/${encoded(path)}/${verb}`,
});

const propertiesOf = (api: ReturnType<typeof vault>, path: string) => {
  const text = api.files.get(path)?.text ?? '';
  return jsonLinesMarkdown().frontmatterProperties(/^---\n[\s\S]*?\n---\n/.exec(text)?.[0] ?? null);
};

describe('GET /v1/proposals', () => {
  it('says why each was proposed, as its body does, cut to a sentence or two', async () => {
    const api = vault({
      [PROPOSAL]: proposal({}, '\nMara Quill took this on, so it waits on them.\n'),
      'Inbox/Proposals/Long.md': proposal({}, 'x'.repeat(5_000)),
    });

    const listed = (
      bodyOf(await api.send({ method: 'GET', path: '/v1/proposals' })) as {
        proposals: { path: string; reason: string }[];
      }
    ).proposals;

    expect(listed.find((each) => each.path === PROPOSAL)?.reason).toBe(
      'Mara Quill took this on, so it waits on them.',
    );
    expect(listed.find((each) => each.path === 'Inbox/Proposals/Long.md')?.reason).toHaveLength(
      1_000,
    );
  });

  it('lists the open proposals with what each would write, and the ones it cannot read', async () => {
    const api = vault({
      'Inbox/Proposals/Odd.md': proposal({ kind: 'meeting' }),
      'Inbox/Proposals/Done.md': proposal({ state: 'rejected' }),
    });
    const response = await api.send({ method: 'GET', path: '/v1/proposals' });

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      proposals: [
        {
          path: PROPOSAL,
          kind: 'task',
          headline: 'Send Mara the payroll file',
          confidence: 'high',
          source: '[[2026-10-01 Standup#^t0003]]',
          madeBy: 'after-meeting · run 1',
          reason: '',
          payload: {
            title: 'Send Mara the payroll file',
            properties: { meeting: '[[2026-10-01 Standup]]' },
          },
          modified: expect.any(Number),
        },
      ],
      stranded: [
        {
          path: 'Inbox/Proposals/Done.md',
          headline: 'Send Mara the payroll file',
          state: 'rejected',
        },
      ],
      unreadable: [{ path: 'Inbox/Proposals/Odd.md', problem: expect.stringMatching(/no kind/) }],
    });
  });

  it('answers no_vault when no vault is open', async () => {
    const api = vault();
    api.open = null;
    expect(codeOf(await api.send({ method: 'GET', path: '/v1/proposals' }))).toBe('no_vault');
  });
});

describe('POST /v1/proposals/{path}/accept', () => {
  it('makes a person proposed from a meeting and links them to it, readable on the meeting (P29-04)', async () => {
    const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
    const PERSON = 'Inbox/Proposals/Ada Venn — Standup.md';
    const api = vault({
      [MEETING]: jsonLinesNote({ type: 'meeting', people: ['[[Mara Quill]]'] }),
      '.atlas/types/meeting.md': jsonLinesNote({
        name: 'meeting',
        properties: { people: { kind: 'relation', target: 'person', many: true } },
      }),
      [PERSON]: jsonLinesNote({
        type: 'proposal',
        kind: 'person',
        source: '[[2026-10-06 Standup]]',
        made_by: 'meeting links',
        payload: {
          title: 'Ada Venn',
          folder: 'People',
          properties: { email: 'ada@larkspur.example' },
          link_from: { note: MEETING, property: 'people' },
        },
      }),
    });
    const response = await api.send(answer(PERSON, 'accept'));

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      accepted: {
        wrote: [
          { kind: 'created', path: 'People/Ada Venn.md' },
          { kind: 'edited', path: MEETING },
        ],
      },
    });
    const read = await api.send({ method: 'GET', path: `/v1/notes/${encoded(MEETING)}` });
    expect(bodyOf(read)).toMatchObject({
      note: { properties: { people: ['[[Mara Quill]]', '[[Ada Venn]]'] } },
    });
    expect(propertiesOf(api, 'People/Ada Venn.md')).toEqual({
      type: 'person',
      email: 'ada@larkspur.example',
    });
  });

  it('accepts a task Waiting with nobody to wait on, as proposed (#202)', async () => {
    const waiting = proposal({
      payload: { title: 'Send Mara the payroll file', properties: { status: 'waiting' } },
    });
    const api = vault({ [PROPOSAL]: waiting });
    const response = await api.send(answer(PROPOSAL, 'accept'));

    expect(response.status).toBe(200);
    expect(propertiesOf(api, TASK)).toMatchObject({ type: 'task', status: 'waiting' });
    expect(propertiesOf(api, TASK)).not.toHaveProperty('waiting_on');
  });

  it('makes the task, archives the proposal as accepted, and logs the write', async () => {
    const api = vault();
    const response = await api.send(answer(PROPOSAL, 'accept'));

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      accepted: {
        proposal: PROPOSAL,
        headline: 'Send Mara the payroll file',
        archivedAt: `Archive/${PROPOSAL}`,
        archiveProblem: null,
        wrote: [{ kind: 'created', path: TASK }],
      },
    });
    expect(propertiesOf(api, TASK)).toMatchObject({
      type: 'task',
      source: '[[2026-10-01 Standup#^t0003]]',
    });
    expect(propertiesOf(api, `Archive/${PROPOSAL}`)).toMatchObject({
      state: 'accepted',
      answered_via: 'api',
      archived: TODAY,
    });
    expect(api.activity.reports).toHaveLength(1);
    expect(api.activity.reports[0]?.message).toMatch(/^POST v1\/proposals\/\{path\}\/accept/);
  });

  it('makes the task under a numbered name when a note is already where it would go', async () => {
    const api = vault({ [TASK]: 'By hand.\n' });
    const response = await api.send(answer(PROPOSAL, 'accept'));

    expect(codeOf(response)).toBeNull();
    expect(JSON.stringify(response.body)).toContain('2.md');
    expect(api.writes.length).toBeGreaterThan(0);
  });

  it('answers conflict for a proposal already decided', async () => {
    const api = vault({ [PROPOSAL]: proposal({ state: 'accepted' }) });
    expect(codeOf(await api.send(answer(PROPOSAL, 'accept')))).toBe('conflict');
  });

  it('refuses a note outside Inbox/Proposals as invalid, and one that is not there as not_found', async () => {
    const api = vault({ 'Notes/Plan.md': proposal() });
    expect(codeOf(await api.send(answer('Notes/Plan.md', 'accept')))).toBe('invalid');
    expect(codeOf(await api.send(answer('Inbox/Proposals/Gone.md', 'accept')))).toBe('not_found');
    expect(codeOf(await api.send(answer('.atlas/Inbox/Proposals/X.md', 'accept')))).toBe('invalid');
    expect(api.writes).toEqual([]);
  });

  it('finds the proposal however its path is cased', async () => {
    const api = vault();
    const response = await api.send(answer(PROPOSAL.toLowerCase(), 'accept'));
    expect(response.status).toBe(200);
  });

  it('leaves a proposal with typing unsaved in DFAI alone, as unsaved_in_app', async () => {
    const api = vault();
    api.deps = {
      ...api.deps,
      movingNotes: {
        ...api.deps.movingNotes,
        state: (path) => (path === PROPOSAL ? 'dirty' : 'closed'),
      },
    };
    expect(codeOf(await api.send(answer(PROPOSAL, 'accept')))).toBe('unsaved_in_app');
    expect(api.writes).toEqual([]);
  });

  it('answers no_vault when another vault is opened while it answers', async () => {
    const api = vault();
    const listed = api.deps.fs.listNotes;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        listNotes: async (options) => {
          api.open = OTHER_VAULT;
          return listed(options);
        },
      },
    };
    expect(codeOf(await api.send(answer(PROPOSAL, 'accept')))).toBe('no_vault');
    expect(api.files.has(TASK)).toBe(false);
  });

  describe('when the proposal cannot be marked accepted for a fault of the disk (#814)', () => {
    const FAULT = 'EIO: i/o error, open /Users/sam/Vault/Inbox/Proposals/x.md';
    const faulty = (trashFails: boolean) => {
      const api = vault();
      const { writeTextFile } = api.deps.fs;
      api.deps = {
        ...api.deps,
        fs: {
          ...api.deps.fs,
          writeTextFile: async (args) => {
            if (args.path === PROPOSAL) throw new Error(FAULT);
            return writeTextFile(args);
          },
          // The fixture's Trash refuses everything, as the API never deletes; this one takes the task.
          trashEntry: async ({ path }) => {
            if (trashFails)
              throw new Error(`EACCES: permission denied, rename /Users/sam/Vault/${TASK}`);
            api.files.delete(path);
          },
        },
      };
      return api;
    };

    it('takes the task back and says so, in words that hold nothing of the fault', async () => {
      const api = faulty(false);
      const response = await api.send(answer(PROPOSAL, 'accept'));
      expect(codeOf(response)).toBe('conflict');
      expect(api.files.has(TASK)).toBe(false);
      expect(JSON.stringify(response.body)).toContain('Nothing was kept.');
      expect(JSON.stringify(response.body)).not.toMatch(/EIO|\/Users/);
      expect(api.activity.reports).toHaveLength(1);
      expect(JSON.stringify(api.activity.reports)).not.toMatch(/EIO|\/Users|i\/o error/);
    });

    it('says what was left when taking it back fails too, without the fault either', async () => {
      const api = faulty(true);
      const response = await api.send(answer(PROPOSAL, 'accept'));
      expect(codeOf(response)).toBe('conflict');
      expect(JSON.stringify(response.body)).toContain('taking it back failed');
      expect(JSON.stringify(response.body)).not.toMatch(/EIO|EACCES|\/Users/);
      expect(JSON.stringify(api.activity.reports)).not.toMatch(/EIO|EACCES|\/Users|denied/);
    });
  });
});

describe('POST /v1/proposals/{path}/reject', () => {
  it('archives the proposal as rejected, writing nothing it proposed', async () => {
    const api = vault();
    const response = await api.send(answer(PROPOSAL, 'reject'));

    expect(bodyOf(response)).toEqual({
      rejected: { proposal: PROPOSAL, archivedAt: `Archive/${PROPOSAL}`, archiveProblem: null },
    });
    expect(propertiesOf(api, `Archive/${PROPOSAL}`)).toMatchObject({
      state: 'rejected',
      answered_via: 'api',
    });
    expect(api.files.has(TASK)).toBe(false);
  });

  it('answers conflict for a proposal already decided', async () => {
    const api = vault({ [PROPOSAL]: proposal({ state: 'rejected' }) });
    expect(codeOf(await api.send(answer(PROPOSAL, 'reject')))).toBe('conflict');
  });
});
