/**
 * The assistant's drafting routes (P32-05): `POST /v1/assistant/make-dashboard`
 * checks a spec and leaves a proposal; `POST /v1/assistant/propose-tasks`
 * drafts a meeting's items as proposals. Neither writes outside
 * Inbox/Proposals, and a dashboard proposal is accepted only in the app.
 */
import { describe, expect, it } from 'vitest';
import { builtInPromptAt, MEETING_EXTRACTION_PROMPT } from '@dfai/domain';
import { apiFixture, bodyOf, codeOf, encoded, OTHER_VAULT } from '../testing/api-fixture.ts';
import { PROPOSE_TASKS_WAIT_MS } from './assistant-proposals.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';

const TASK_TYPE = jsonLinesNote({
  name: 'task',
  properties: { status: { kind: 'select', options: ['inbox', 'done'] } },
});
const MEETING = 'Meetings/2026-10-01 Larkspur Payroll sync.md';
const MEETING_NOTE = jsonLinesNote(
  { type: 'meeting', title: 'Larkspur Payroll sync', date: '2026-10-01' },
  '# Larkspur Payroll sync\n\n## Transcript\n\n**Mara Quill** 00:01\nI will send the payroll file. ^t0001\n',
);
const SPEC = {
  kind: 'dashboard',
  name: 'Larkspur Payroll',
  widgets: [{ kind: 'bar', type: 'task', groupBy: 'status' }],
};

function vault(files: Record<string, string> = {}) {
  return apiFixture({
    files: {
      '.atlas/types/task.md': TASK_TYPE,
      [MEETING]: MEETING_NOTE,
      [MEETING_EXTRACTION_PROMPT]: builtInPromptAt(MEETING_EXTRACTION_PROMPT)!.contents,
      ...files,
    },
    markdown: jsonLinesMarkdown(),
  });
}

const makeDashboard = (spec: unknown) => ({
  method: 'POST' as const,
  path: '/v1/assistant/make-dashboard',
  body: { spec },
});
const proposeTasks = (meeting: unknown) => ({
  method: 'POST' as const,
  path: '/v1/assistant/propose-tasks',
  body: { meeting },
});
const atlasWrites = (api: ReturnType<typeof vault>) =>
  api.writes.filter(({ path }) => path.toLowerCase().includes('.atlas'));

describe('POST /v1/assistant/make-dashboard', () => {
  it('leaves a checked dashboard as a proposal and writes nothing into .atlas', async () => {
    const api = vault();

    const response = await api.send(makeDashboard(SPEC));

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      proposedSpec: {
        kind: 'dashboard',
        title: 'Larkspur Payroll',
        proposal: 'Inbox/Proposals/Larkspur Payroll.md',
        problem: null,
      },
    });
    expect(api.writes.map(({ path }) => path)).toEqual(['Inbox/Proposals/Larkspur Payroll.md']);
    const listed = bodyOf(await api.send({ method: 'GET', path: '/v1/proposals' })) as {
      proposals: { kind: string; payload: unknown }[];
    };
    expect(listed.proposals).toMatchObject([
      {
        kind: 'dashboard',
        payload: { title: 'Larkspur Payroll', spec: { widgets: SPEC.widgets } },
      },
    ]);
  });

  it('refuses an invalid spec with the checker’s problems, verbatim and each where it is', async () => {
    const api = vault();

    const response = await api.send(
      makeDashboard({ kind: 'dashboard', name: '', widgets: [{ kind: 'bar', type: 'deal' }] }),
    );

    expect(codeOf(response)).toBe('invalid');
    expect(response.status).toBe(400);
    expect((bodyOf(response) as { error: { problems: unknown } }).error.problems).toEqual([
      { at: 'name', message: 'Name the dashboard.' },
      { at: 'widgets[0]', message: 'There is no type called “deal”.' },
      { at: 'widgets[0]', message: 'A bar chart needs a property to group by.' },
    ]);
    expect((bodyOf(response) as { error: { message: string } }).error.message).toBe(
      'The spec was refused: 3 problems, each in problems.',
    );
    expect(api.writes).toEqual([]);
  });

  it.each([[{}], [{ spec: 'a dashboard' }], [null]])('refuses a body of %j', async (body) => {
    const api = vault();
    const response = await api.send({ method: 'POST', path: '/v1/assistant/make-dashboard', body });
    expect(codeOf(response)).toBe('invalid');
    expect(api.writes).toEqual([]);
  });

  it('lists at most 50 problems, and says how many more there were', async () => {
    const api = vault();
    const filters = Array.from({ length: 60 }, () => 'not a filter');

    const response = await api.send(
      makeDashboard({
        kind: 'dashboard',
        name: 'Board',
        widgets: [{ kind: 'number', type: 'task', filters }],
      }),
    );

    const { problems } = (
      bodyOf(response) as { error: { problems: { at: string; message: string }[] } }
    ).error;
    expect(problems).toHaveLength(51);
    expect(problems.at(-1)).toEqual({ at: 'spec', message: '… and 10 more.' });
    expect((bodyOf(response) as { error: { message: string } }).error.message).toBe(
      'The spec was refused: 60 problems, each in problems.',
    );
  });

  it('proposes the same spec once', async () => {
    const api = vault();
    await api.send(makeDashboard(SPEC));

    const again = await api.send(makeDashboard(SPEC));

    expect(bodyOf(again)).toMatchObject({
      proposedSpec: {
        proposal: null,
        problem: {
          message: 'It is proposed already, waiting in the Inbox.',
          proposal: 'Inbox/Proposals/Larkspur Payroll.md',
        },
      },
    });
    expect(api.writes).toHaveLength(1);
  });

  it('is accepted only in the app: the API’s accept is forbidden and writes nothing', async () => {
    const api = vault();
    await api.send(makeDashboard(SPEC));
    const proposal = 'Inbox/Proposals/Larkspur Payroll.md';
    const before = api.files.get(proposal)?.text;

    const response = await api.send({
      method: 'POST',
      path: `/v1/proposals/${encoded(proposal)}/accept`,
    });

    expect(codeOf(response)).toBe('forbidden');
    expect(response.status).toBe(403);
    expect(atlasWrites(api)).toEqual([]);
    expect(api.files.get(proposal)?.text).toBe(before);
  });

  it('is rejected through the API like any proposal, writing nothing into .atlas', async () => {
    const api = vault();
    await api.send(makeDashboard(SPEC));

    const response = await api.send({
      method: 'POST',
      path: `/v1/proposals/${encoded('Inbox/Proposals/Larkspur Payroll.md')}/reject`,
    });

    expect(response.status).toBe(200);
    expect(atlasWrites(api)).toEqual([]);
  });
});

describe('POST /v1/assistant/propose-tasks', () => {
  const ITEMS = [
    {
      type: 'text' as const,
      text: JSON.stringify({
        items: [
          {
            kind: 'task',
            title: 'Send the payroll file',
            owner: 'Mara Quill',
            source_block: 't0001',
            confidence: 'high',
          },
        ],
      }),
    },
  ];

  it('drafts the meeting’s items as proposals, writing only into Inbox/Proposals', async () => {
    const api = vault();
    api.claudeStep = fakeClaudeStepPorts({ rounds: [ITEMS], selfName: 'Mara Quill' });

    const response = await api.send(proposeTasks(MEETING));

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      proposedTasks: { meeting: MEETING, alreadyProposed: 0, dropped: [] },
    });
    const { proposed } = (bodyOf(response) as { proposedTasks: { proposed: string[] } })
      .proposedTasks;
    expect(proposed).toHaveLength(1);
    expect(api.writes.map(({ path }) => path)).toEqual(proposed);
    expect(proposed[0]).toMatch(/^Inbox\/Proposals\//);
  });

  /**
   * Claude's answer held until `release`, and the route's wait — the deadline
   * asked for `PROPOSE_TASKS_WAIT_MS`, whichever call it is — run out at once.
   */
  function heldPastTheWait(api: ReturnType<typeof vault>, { fails = false } = {}) {
    const claude = fakeClaudeStepPorts({ rounds: [ITEMS], selfName: 'Mara Quill' });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    api.claudeStep = {
      ...claude,
      deadline: (ms) => {
        const signal = claude.deadline(ms);
        if (ms === PROPOSE_TASKS_WAIT_MS) claude.deadlines.at(-1)!.abort();
        return signal;
      },
      provider: () => ({
        ...claude.provider(),
        stream: async function* (request, signal) {
          await held;
          if (fails) throw new Error('the model went away');
          yield* claude.provider().stream(request, signal);
        },
      }),
    };
    return { claude, release: () => release() };
  }

  it('answers 202 and keeps going when the draft outlasts the wait', async () => {
    const api = vault();
    const { release } = heldPastTheWait(api);

    const response = await api.send(proposeTasks(MEETING));

    expect(response.status).toBe(202);
    expect(bodyOf(response)).toEqual({ proposingTasks: { meeting: MEETING, running: true } });
    // While it runs, asking again is refused rather than paying for a second answer.
    expect(codeOf(await api.send(proposeTasks(MEETING)))).toBe('conflict');
    release();
    await expect.poll(() => api.writes.length).toBe(1);
    // Done after its answer: said in the vault's Activity, and no notice, since nothing went wrong.
    await expect
      .poll(() => api.activity.reports.map(({ message }) => message))
      .toContain('Drafted 1 proposals from 2026-10-01 Larkspur Payroll sync.');
    expect(api.notices).toEqual([]);
  });

  it('says a draft that failed after its 202, naming the meeting and why, in Activity and a notice', async () => {
    const api = vault();
    const { release } = heldPastTheWait(api, { fails: true });
    expect((await api.send(proposeTasks(MEETING))).status).toBe(202);

    release();

    await expect.poll(() => api.notices.length).toBe(1);
    expect(api.notices[0]).toMatch(
      /^Drafting the tasks of 2026-10-01 Larkspur Payroll sync stopped: .*the model went away/,
    );
    expect(api.activity.reports).toContainEqual({
      level: 'error',
      kind: 'api',
      message: api.notices[0],
      subject: { kind: 'note', path: MEETING },
    });
    expect(api.writes).toEqual([]);
  });

  it('says a meeting deleted while it was drafted, after its 202, and writes nothing', async () => {
    const api = vault();
    const { release } = heldPastTheWait(api);
    expect((await api.send(proposeTasks(MEETING))).status).toBe(202);

    api.files.delete(MEETING);
    release();

    await expect.poll(() => api.notices.length).toBe(1);
    expect(api.notices[0]).toContain(`${MEETING} is not there any more`);
    expect(api.writes).toEqual([]);
  });

  it('says a vault closed while it drafted, after its 202, and writes nothing', async () => {
    const api = vault();
    const { release } = heldPastTheWait(api);
    expect((await api.send(proposeTasks(MEETING))).status).toBe(202);

    api.open = OTHER_VAULT;
    release();

    await expect.poll(() => api.notices.length).toBe(1);
    expect(api.notices[0]).toMatch(/vault (this request was for )?is (no longer|not) open/);
    expect(api.writes).toEqual([]);
  });

  it('does not ask Claude again about a meeting whose words are unchanged, and says so', async () => {
    const api = vault();
    const claude = fakeClaudeStepPorts({ rounds: [ITEMS, ITEMS], selfName: 'Mara Quill' });
    api.claudeStep = claude;
    await api.send(proposeTasks(MEETING));

    const again = await api.send(proposeTasks(MEETING));

    expect(bodyOf(again)).toMatchObject({
      proposedTasks: { proposed: [], alreadyProposed: 1, unchanged: true },
    });
    expect(claude.fake.requests).toHaveLength(1);
  });

  it('is refused while DFAI has no Claude to ask', async () => {
    const api = vault();
    const response = await api.send(proposeTasks(MEETING));
    expect(codeOf(response)).toBe('conflict');
    expect((bodyOf(response) as { error: { message: string } }).error.message).toMatch(
      /Settings → Claude/,
    );
  });

  it('says why Claude could not draft it, writing nothing', async () => {
    const api = vault();
    api.claudeStep = fakeClaudeStepPorts({ rounds: [[{ type: 'text', text: 'not JSON' }]] });
    const response = await api.send(proposeTasks(MEETING));
    expect(codeOf(response)).toBe('conflict');
    expect((bodyOf(response) as { error: { message: string } }).error.message).toMatch(
      /^Claude could not draft it: /,
    );
    expect(api.writes).toEqual([]);
  });

  it.each([
    ['.atlas/types/task.md', 'invalid'],
    ['.ATLAS/types/task.md', 'invalid'],
    ['x/../.atlas/types/task.md', 'invalid'],
    ['Notes/Gone.md', 'not_found'],
    [7, 'invalid'],
  ])('refuses the meeting %j (%s), without asking Claude', async (meeting, code) => {
    const api = vault();
    const claude = fakeClaudeStepPorts();
    api.claudeStep = claude;
    const response = await api.send(proposeTasks(meeting));
    expect(codeOf(response)).toBe(code);
    expect(claude.fake.requests).toEqual([]);
  });

  it('names a meeting it did not ask about, and why, in left — a meeting with no transcript', async () => {
    const api = vault({
      'Meetings/Quiet.md': jsonLinesNote(
        { type: 'meeting', title: 'Quiet' },
        '# Quiet\n\nNo one spoke.\n',
      ),
    });
    const claude = fakeClaudeStepPorts();
    api.claudeStep = claude;

    const response = await api.send(proposeTasks('Meetings/Quiet.md'));

    expect(response.status).toBe(200);
    const { proposedTasks } = bodyOf(response) as {
      proposedTasks: { proposed: string[]; left: { path: string; reason: string }[] };
    };
    expect(proposedTasks.proposed).toEqual([]);
    expect(proposedTasks.left).toEqual([
      { path: 'Meetings/Quiet.md', reason: expect.stringMatching(/\S/) as string },
    ]);
    expect(claude.fake.requests).toEqual([]);
    expect(api.writes).toEqual([]);
  });

  it('refuses a note that is not a meeting', async () => {
    const api = vault({ 'Tasks/Send it.md': jsonLinesNote({ type: 'task' }) });
    api.claudeStep = fakeClaudeStepPorts();
    const response = await api.send(proposeTasks('Tasks/Send it.md'));
    expect(codeOf(response)).toBe('invalid');
    expect((bodyOf(response) as { error: { message: string } }).error.message).toBe(
      'Tasks/Send it.md is not a meeting note.',
    );
  });
});
