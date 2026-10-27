/**
 * Automations through the API (P25), read-only: the rules and their state as
 * the Automations page lists them, a rule's log, and a dry run that writes
 * nothing. Running, undoing and editing stay in the app (ADR-0016).
 */

import { describe, expect, it } from 'vitest';
import { digestOf, newLogText, VAULT_WALK_DEPTH, type LogEntry } from '@dfai/domain';
import { apiFixture, bodyOf, codeOf, encoded, OTHER_VAULT, VAULT } from '../testing/api-fixture.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';

const rule = (fields: Record<string, unknown>) =>
  jsonNote({ atlas: 'automation', enabled: true, ...fields });

const TIDY = rule({
  id: 'tidy',
  name: 'Tidy done tasks',
  when: 'daily at 03:00',
  which: 'FROM task WHERE status = done',
  do: 'archive',
});
const FINISH = rule({
  id: 'finish',
  name: 'Finish doing',
  when: 'manually',
  which: 'FROM task WHERE status = doing',
  do: 'set',
  set: { status: 'done' },
});

const RAN: LogEntry = {
  kind: 'run',
  at: '2026-09-21T03:00:04',
  trigger: 'schedule',
  done: [{ kind: 'archived', from: 'tasks/Old.md' as never, to: 'Archive/tasks/Old.md' as never }],
  left: [{ path: '.atlas/x.md' as never, reason: 'DFAI keeps its own files as they are.' }],
  capped: false,
};
const FAILED: LogEntry = {
  kind: 'failed',
  at: '2026-09-22T03:00:01',
  trigger: 'schedule',
  problem: 'No type called tsk.',
};

const FILES: Record<string, string> = {
  '.atlas/types/task.md': jsonNote({
    name: 'task',
    label: 'Task',
    properties: { status: { kind: 'select', options: ['todo', 'doing', 'done'] } },
  }),
  '.atlas/automations/Tidy done tasks.md': TIDY,
  '.atlas/automations/Finish doing.md': FINISH,
  '.atlas/automations/log/tidy.md': newLogText('Tidy done tasks', [RAN, FAILED]),
  '.atlas/automations/Broken.md': rule({ name: 'Broken', which: 'FROM task', do: 'archive' }),
  'tasks/A.md': jsonNote({ type: 'task', status: 'doing' }),
  'tasks/B.md': jsonNote({ type: 'task', status: 'done' }),
  'tasks/C.md': jsonNote({ type: 'task', status: 'done' }),
};

/** A note as deep as the walk reaches: the Archive's folder would put it past, so it is passed over. */
const DEEP = (name: string) => `${'d/'.repeat(VAULT_WALK_DEPTH)}${name}.md`;

type Api = ReturnType<typeof apiFixture>;

function vault(files: Record<string, string> = FILES): Api {
  const markdown = jsonMarkdown();
  return apiFixture({ files, markdown, index: { query: atlasQueryIndex({ files, markdown }) } });
}

const list = (api: Api) => api.send({ method: 'GET', path: '/v1/automations' });
const logOf = (api: Api, id: string, query: Record<string, string> = {}) =>
  api.send({ method: 'GET', path: `/v1/automations/${encoded(id)}/log`, query });
const dryRun = (api: Api, id: string) =>
  api.send({ method: 'POST', path: `/v1/automations/${encoded(id)}/dry-run` });

describe('GET /v1/automations', () => {
  it('lists each rule as its file says it, with its last and next run, sorted by name', async () => {
    const response = await list(vault());

    expect(response.status).toBe(200);
    const { automations } = bodyOf(response) as { automations: Record<string, unknown>[] };
    expect(automations.map((automation) => automation['name'])).toEqual([
      'Finish doing',
      'Tidy done tasks',
    ]);
    expect(automations[1]).toEqual({
      id: 'tidy',
      name: 'Tidy done tasks',
      path: '.atlas/automations/Tidy done tasks.md',
      enabled: true,
      when: 'daily at 03:00',
      note: null,
      which: 'FROM task WHERE status = done',
      olderThanDays: null,
      do: 'archive',
      set: null,
      claude: null,
      schedule: 'Every day at 03:00',
      action: 'Archive',
      lastRun: {
        at: '2026-09-22T03:00:01',
        kind: 'failed',
        trigger: 'schedule',
        summary: 'No type called tsk.',
      },
      // Counted from its last scheduled run, as the app's clock counts it.
      nextRun: '2026-09-23T03:00:00',
      // A rule on the Mac's clock names no other zone.
      timeZone: null,
      paused: null,
    });
    expect(automations[0]).toMatchObject({
      id: 'finish',
      do: 'set',
      set: { status: 'done' },
      action: 'Set status to done',
      lastRun: null,
      nextRun: null,
    });
  });

  it('lists a rule its file cannot be read as broken, with why, and never as a rule', async () => {
    const { broken } = bodyOf(await list(vault())) as { broken: unknown[] };

    expect(broken).toEqual([
      {
        path: '.atlas/automations/Broken.md',
        name: 'Broken',
        problem:
          'Say when it runs: daily at 03:00, fridays at 15:00, every 6 hours, on app open, manually, ' +
          'or when a note appears, like a meeting is created or changed.',
      },
    ]);
  });

  it("says why the app's clock has paused a rule, and gives it no next run until run by hand", async () => {
    const api = vault();
    api.automations.set(VAULT.absolutePath, {
      watchingSince: '2026-09-22T08:00:00',
      pauses: new Map([
        ['tidy', { reason: 'Paused: its log could not be written.', retryAt: null }],
      ]),
    });

    const { automations } = bodyOf(await list(api)) as { automations: Record<string, unknown>[] };

    expect(automations[1]).toMatchObject({
      paused: 'Paused: its log could not be written.',
      nextRun: null,
    });
  });

  it("says why a rule is paused without this machine's paths", async () => {
    const api = vault();
    const reason =
      'Paused: Its log could not be written (Permission denied: /Users/j/Vault/.atlas/automations/log/tidy.md). Run it by hand to try again.';
    api.automations.set(VAULT.absolutePath, {
      watchingSince: '2026-09-22T08:00:00',
      pauses: new Map([['tidy', { reason, retryAt: null }]]),
    });

    const { automations } = bodyOf(await list(api)) as { automations: Record<string, unknown>[] };

    expect(automations[1]?.['paused']).toBe(
      'Paused: Its log could not be written (Permission denied: <path>). Run it by hand to try again.',
    );
  });

  it('counts a never-run rule from when the app began watching the vault', async () => {
    const files = {
      ...FILES,
      '.atlas/automations/Hourly.md': rule({
        id: 'hourly',
        name: 'Hourly',
        when: 'every 6 hours',
        which: 'FROM task',
        do: 'archive',
      }),
    };
    const api = vault(files);
    const hourly = async () =>
      ((bodyOf(await list(api)) as { automations: Record<string, unknown>[] }).automations.find(
        (automation) => automation['id'] === 'hourly',
      ) ?? {})['nextRun'];

    // Not watched yet: counted from now, 09:00.
    expect(await hourly()).toBe('2026-09-22T15:00:00');
    api.automations.set(VAULT.absolutePath, {
      watchingSince: '2026-09-22T05:00:00',
      pauses: new Map(),
    });
    expect(await hourly()).toBe('2026-09-22T11:00:00');
    // Another vault's runner is not this vault's.
    api.automations.clear();
    api.automations.set(OTHER_VAULT.absolutePath, {
      watchingSince: '2026-09-22T05:00:00',
      pauses: new Map(),
    });
    expect(await hourly()).toBe('2026-09-22T15:00:00');
  });

  it('answers an empty list for a vault with no automations', async () => {
    const response = await list(vault({ 'tasks/A.md': jsonNote({ type: 'task' }) }));

    expect(bodyOf(response)).toEqual({ automations: [], broken: [] });
  });

  it('refuses with no_vault when the vault is switched while it reads', async () => {
    const api = vault();
    const readNotes = api.deps.fs.readNotes;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        readNotes: async (paths) => {
          api.open = OTHER_VAULT;
          return readNotes(paths);
        },
      },
    };

    expect(codeOf(await list(api))).toBe('no_vault');
  });
});

describe('GET /v1/automations/{id}/log', () => {
  it("answers the rule's log newest first, each entry in full", async () => {
    const response = await logOf(vault(), 'tidy');

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      automation: { id: 'tidy', name: 'Tidy done tasks' },
      entries: [
        {
          kind: 'failed',
          at: '2026-09-22T03:00:01',
          heading: 'Ran on schedule, and could not',
          summary: 'No type called tsk.',
          trigger: 'schedule',
          problem: 'No type called tsk.',
          done: [],
          left: [],
        },
        {
          kind: 'run',
          at: '2026-09-21T03:00:04',
          heading: 'Ran on schedule',
          summary: 'Archived 1 note. Left 1 alone.',
          trigger: 'schedule',
          capped: false,
          done: [{ kind: 'archived', from: 'tasks/Old.md', to: 'Archive/tasks/Old.md' }],
          left: [{ path: '.atlas/x.md', reason: 'DFAI keeps its own files as they are.' }],
        },
      ],
      truncated: false,
    });
  });

  it('answers an undo with the run it undid and what it put back, and turning on as itself', async () => {
    const entries: LogEntry[] = [
      { kind: 'seen', at: '2026-09-20T08:00:00' },
      { kind: 'turnedOn', at: '2026-09-20T09:00:00' },
      {
        kind: 'undo',
        at: '2026-09-21T10:00:00',
        of: '2026-09-21T03:00:04',
        done: [
          {
            kind: 'restored',
            path: 'tasks/A.md' as never,
            key: 'status',
            before: { value: 'done' },
            after: { value: 'doing' },
          },
        ],
        left: [],
      },
    ];
    const files = { ...FILES, '.atlas/automations/log/finish.md': newLogText('Finish', entries) };

    const body = bodyOf(await logOf(vault(files), 'finish'));

    expect(body['entries']).toEqual([
      {
        kind: 'undo',
        at: '2026-09-21T10:00:00',
        heading: 'Undid the run of 2026-09-21 03:00:04',
        summary: 'Restored 1 note.',
        of: '2026-09-21T03:00:04',
        done: [
          {
            kind: 'restored',
            path: 'tasks/A.md',
            key: 'status',
            before: { value: 'done' },
            after: { value: 'doing' },
          },
        ],
        left: [],
      },
      expect.objectContaining({ kind: 'turnedOn', heading: 'Turned on', done: [], left: [] }),
      expect.objectContaining({ kind: 'seen', heading: 'First seen', done: [], left: [] }),
    ]);
  });

  it('keeps to limit, newest first, and says there is more', async () => {
    const body = bodyOf(await logOf(vault(), 'tidy', { limit: '1' }));

    expect((body['entries'] as { at: string }[]).map((entry) => entry.at)).toEqual([
      '2026-09-22T03:00:01',
    ]);
    expect(body['truncated']).toBe(true);
  });

  it('finds a rule whatever the case of its id, and answers an empty log for one never run', async () => {
    const body = bodyOf(await logOf(vault(), 'FINISH'));

    expect(body).toEqual({
      automation: { id: 'finish', name: 'Finish doing' },
      entries: [],
      truncated: false,
    });
  });

  it('refuses an unknown id with not_found', async () => {
    const response = await logOf(vault(), 'nope');

    expect(response.status).toBe(404);
    expect(codeOf(response)).toBe('not_found');
  });

  it('refuses a very long unknown id without echoing all of it', async () => {
    const response = await logOf(vault(), 'x'.repeat(5000));

    expect(codeOf(response)).toBe('not_found');
    const { message } = (bodyOf(response) as { error: { message: string } }).error;
    expect(message).toContain('xxxx');
    expect(message.length).toBeLessThan(200);
  });

  it('refuses a broken rule with invalid, saying why it cannot be read', async () => {
    const response = await logOf(vault(), 'Broken');

    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(bodyOf(response))).toContain('Say when it runs');
  });

  it('refuses a limit out of range, and an id that is not validly encoded', async () => {
    expect(codeOf(await logOf(vault(), 'tidy', { limit: '0' }))).toBe('invalid');
    expect(codeOf(await logOf(vault(), 'tidy', { limit: '101' }))).toBe('invalid');
    const response = await vault().send({ method: 'GET', path: '/v1/automations/%E0%A4/log' });
    expect(codeOf(response)).toBe('invalid');
  });

  it('refuses with no_vault when the vault is switched while it reads', async () => {
    const api = vault();
    const readNotes = api.deps.fs.readNotes;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        readNotes: async (paths) => {
          if (paths.some((path) => path.includes('/log/'))) api.open = OTHER_VAULT;
          return readNotes(paths);
        },
      },
    };

    expect(codeOf(await logOf(api, 'tidy'))).toBe('no_vault');
  });
});

describe('POST /v1/automations/{id}/dry-run', () => {
  it('answers the notes an archive rule would take now, and writes nothing', async () => {
    const api = vault();
    const before = new Map([...api.files].map(([path, note]) => [path, note.text]));

    const response = await dryRun(api, 'tidy');

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      automation: { id: 'tidy', name: 'Tidy done tasks' },
      plan: {
        do: 'archive',
        set: null,
        claude: null,
        summary: 'Would archive 2 notes.',
        notes: [
          { path: 'tasks/B.md', title: 'B' },
          { path: 'tasks/C.md', title: 'C' },
        ],
        passedOver: [],
        passedOverMore: 0,
        capped: false,
        cap: 500,
      },
    });
    expect(api.writes).toEqual([]);
    expect(api.flushed).toEqual([]);
    expect(api.followed).toEqual([]);
    expect(new Map([...api.files].map(([path, note]) => [path, note.text]))).toEqual(before);
  });

  it('answers what a set rule would set, leaving out notes that already hold it', async () => {
    const files = { ...FILES, 'tasks/D.md': jsonNote({ type: 'task', status: 'doing' }) };
    const api = vault(files);

    const { plan } = bodyOf(await dryRun(api, 'finish')) as { plan: Record<string, unknown> };

    expect(plan).toMatchObject({
      do: 'set',
      set: { status: 'done' },
      summary: 'Would change 2 notes.',
      notes: [
        { path: 'tasks/A.md', title: 'A' },
        { path: 'tasks/D.md', title: 'D' },
      ],
    });
    expect(api.writes).toEqual([]);
  });

  it('answers the notes it matched and would leave alone, with why', async () => {
    const files = { ...FILES, [DEEP('Z')]: jsonNote({ type: 'task', status: 'done' }) };

    const { plan } = bodyOf(await dryRun(vault(files), 'tidy')) as {
      plan: { notes: unknown[]; passedOver: { path: string; reason: string }[] };
    };

    expect(plan.notes).toHaveLength(2);
    expect(plan.passedOver).toEqual([
      {
        path: DEEP('Z'),
        reason: 'It is too many folders deep: in the Archive, DFAI would no longer read it.',
      },
    ]);
    expect(plan).toMatchObject({ passedOverMore: 0 });
  });

  it('answers at most 500 notes passed over, and counts the rest', async () => {
    const deep = Object.fromEntries(
      Array.from({ length: 620 }, (_, at) => [
        DEEP(`Z${String(at).padStart(4, '0')}`),
        jsonNote({ type: 'task', status: 'done' }),
      ]),
    );

    const response = await dryRun(vault({ ...FILES, ...deep }), 'tidy');

    const { plan } = bodyOf(response) as {
      plan: { notes: unknown[]; passedOver: unknown[]; passedOverMore: number };
    };
    expect(plan.notes).toHaveLength(2);
    expect(plan.passedOver).toHaveLength(500);
    expect(plan.passedOverMore).toBe(120);
  });

  it('answers a dry run for a rule that is turned off, as the app does', async () => {
    const files = {
      ...FILES,
      '.atlas/automations/Tidy done tasks.md': rule({
        id: 'tidy',
        name: 'Tidy done tasks',
        enabled: false,
        when: 'daily at 03:00',
        which: 'FROM task WHERE status = done',
        do: 'archive',
      }),
    };

    const response = await dryRun(vault(files), 'tidy');

    expect(response.status).toBe(200);
  });

  it('refuses a rule whose query does not read with query_failed, saying why', async () => {
    const files = {
      ...FILES,
      '.atlas/automations/Typo.md': rule({
        id: 'typo',
        name: 'Typo',
        when: 'manually',
        which: 'FROM tsk',
        do: 'archive',
      }),
    };
    const api = vault(files);

    const response = await dryRun(api, 'typo');

    expect(codeOf(response)).toBe('query_failed');
    expect(JSON.stringify(bodyOf(response))).toContain('tsk');
    expect(api.writes).toEqual([]);
  });

  it("answers query_failed without this machine's paths when the index refuses", async () => {
    const markdown = jsonMarkdown();
    const api = apiFixture({
      files: FILES,
      markdown,
      index: {
        query: async () => {
          throw new Error('unable to open /Users/j/Vault/.atlas-cache/index.db');
        },
      },
    });

    const response = await dryRun(api, 'tidy');

    expect(codeOf(response)).toBe('query_failed');
    expect(JSON.stringify(bodyOf(response))).not.toContain('/Users/j');
  });

  it('refuses an unknown id with not_found, and a broken rule with invalid', async () => {
    expect(codeOf(await dryRun(vault(), 'nope'))).toBe('not_found');
    expect(codeOf(await dryRun(vault(), 'broken'))).toBe('invalid');
  });

  it('refuses with no_vault when the vault is switched while the index answers', async () => {
    const api = vault();
    const query = api.deps.index.query;
    api.deps = {
      ...api.deps,
      index: {
        ...api.deps.index,
        query: async (sql, parameters) => {
          api.open = OTHER_VAULT;
          return query(sql, parameters);
        },
      },
    };

    const response = await dryRun(api, 'tidy');

    expect(codeOf(response)).toBe('no_vault');
    expect(api.writes).toEqual([]);
  });

  it('is not a route for GET, and running or undoing is no route at all', async () => {
    const api = vault();
    for (const request of [
      { method: 'GET' as const, path: '/v1/automations/tidy/dry-run' },
      { method: 'POST' as const, path: '/v1/automations/tidy/run' },
      { method: 'POST' as const, path: '/v1/automations/tidy/undo' },
      { method: 'POST' as const, path: '/v1/automations' },
      { method: 'GET' as const, path: '/v1/automations//log' },
    ]) {
      expect(codeOf(await api.send(request))).toBe('not_found_route');
    }
    expect(api.writes).toEqual([]);
  });
});

describe('a rule a note sets off, through the API (P29-01)', () => {
  const FILE_DONE = rule({
    id: 'file',
    name: 'File done tasks',
    when: 'a task is created or changed',
    which: 'FROM task WHERE status = done',
    do: 'archive',
  });
  const HANDLED: LogEntry = {
    kind: 'run',
    at: '2026-10-08T09:00:00',
    trigger: 'note',
    done: [],
    left: [{ path: 'tasks/B.md' as never, reason: 'It is open in DFAI with unsaved typing.' }],
    capped: false,
    versions: [
      { path: 'tasks/B.md' as never, digest: digestOf(FILES['tasks/B.md']!), wrote: false },
    ],
  };
  const files: Record<string, string> = {
    ...FILES,
    '.atlas/automations/File done tasks.md': FILE_DONE,
    '.atlas/automations/log/file.md': newLogText('File done tasks', [HANDLED]),
  };
  /** The index's manifest: each note's version as it was last read. */
  const manifest = async () =>
    Object.entries(files).map(([path, text]) => ({
      path,
      modified: 0,
      size: text.length,
      type: null,
      digest: digestOf(text),
    }));
  function noteVault(): Api {
    const markdown = jsonMarkdown();
    return apiFixture({
      files,
      markdown,
      index: { query: atlasQueryIndex({ files, markdown }), manifest },
    });
  }

  it('lists the note that sets it off, and gives it no next run', async () => {
    const { automations } = bodyOf(await list(noteVault())) as {
      automations: Record<string, unknown>[];
    };

    expect(automations.find((automation) => automation['id'] === 'file')).toMatchObject({
      when: 'a task is created or changed',
      note: { type: 'task', on: ['created', 'changed'] },
      schedule: 'When a task is created or changed',
      lastRun: { trigger: 'note', summary: 'Nothing to do. Left 1 alone.' },
      nextRun: null,
    });
  });

  it('answers the notes a log says went', async () => {
    const went: LogEntry = { ...HANDLED, went: ['tasks/Gone.md' as never] };
    const withGone = {
      ...files,
      '.atlas/automations/log/file.md': newLogText('File done tasks', [went]),
    };
    const markdown = jsonMarkdown();
    const api = apiFixture({
      files: withGone,
      markdown,
      index: { query: atlasQueryIndex({ files: withGone, markdown }) },
    });
    const { entries } = bodyOf(await logOf(api, 'file')) as { entries: Record<string, unknown>[] };

    expect(entries[0]).toMatchObject({ went: ['tasks/Gone.md'] });
  });

  it('answers the versions a run handled, in its log', async () => {
    const { entries } = bodyOf(await logOf(noteVault(), 'file')) as {
      entries: Record<string, unknown>[];
    };

    expect(entries[0]).toMatchObject({
      heading: 'Ran when a note appeared or changed',
      trigger: 'note',
      versions: [{ path: 'tasks/B.md', digest: digestOf(FILES['tasks/B.md']!), wrote: false }],
    });
  });

  it('dry-runs to the notes it has not handled as they are now, as the app does', async () => {
    const { plan } = bodyOf(await dryRun(noteVault(), 'file')) as {
      plan: { notes: { path: string }[] };
    };

    expect(plan.notes.map((note) => note.path)).toEqual(['tasks/C.md']);
  });
});

describe('a rule with a Claude step, through the API (P29-03)', () => {
  const ASK = rule({
    id: 'ask',
    name: 'Ask about tasks',
    when: 'manually',
    which: 'FROM task WHERE status = done',
    do: 'claude',
    prompt: '.atlas/prompts/tasks.md',
    tools: ['atlas_read_note', 'atlas_search'],
    output: 'note',
    folder: 'Briefs',
  });
  const files = { ...FILES, '.atlas/automations/Ask about tasks.md': ASK };
  const step = {
    prompt: '.atlas/prompts/tasks.md',
    tools: ['atlas_read_note', 'atlas_search'],
    output: 'note',
    folder: 'Briefs',
    data: null,
  };

  it('lists it with its prompt, its tools and what it writes', async () => {
    const { automations } = bodyOf(await list(vault(files))) as {
      automations: Record<string, unknown>[];
    };
    expect(automations.find((automation) => automation['id'] === 'ask')).toMatchObject({
      do: 'claude',
      set: null,
      claude: step,
      action: 'Ask Claude (tasks) for a note in Briefs',
    });
    expect(automations.find((automation) => automation['id'] === 'tidy')).toMatchObject({
      claude: null,
    });
  });

  it('lists a step handed the weekly review with its data, its weekly schedule and no query (#40)', async () => {
    const review = jsonNote({
      atlas: 'automation',
      id: 'friday',
      name: 'Friday review',
      enabled: true,
      when: 'fridays at 15:00',
      do: 'claude',
      prompt: '.atlas/prompts/friday-review.md',
      output: 'note',
      folder: 'Reviews',
      data: 'weekly-review',
    });
    const withReview = { ...files, '.atlas/automations/Friday review.md': review };
    const { automations } = bodyOf(await list(vault(withReview))) as {
      automations: Record<string, unknown>[];
    };
    expect(automations.find((automation) => automation['id'] === 'friday')).toMatchObject({
      when: 'fridays at 15:00',
      which: '',
      schedule: 'Every Friday at 15:00',
      claude: { output: 'note', folder: 'Reviews', data: 'weekly-review' },
    });
  });

  it('names the zone the morning brief’s next run is on, the calendar’s, and no zone for the others (#587)', async () => {
    const brief = jsonNote({
      atlas: 'automation',
      id: 'brief',
      name: 'Morning brief',
      enabled: true,
      when: 'daily at 07:00',
      do: 'claude',
      prompt: '.atlas/prompts/morning-brief.md',
      output: 'note',
      folder: 'Briefs',
      data: 'meeting-briefs',
    });
    const kept = {
      ...files,
      '.atlas/automations/Morning brief.md': brief,
      '.atlas/settings.md': jsonNote({ google_plan_zone: 'America/Chicago' }),
    };
    const { automations } = bodyOf(await list(vault(kept))) as {
      automations: Record<string, unknown>[];
    };
    const byId = (id: string) => automations.find((automation) => automation['id'] === id);
    expect(byId('brief')).toMatchObject({ timeZone: 'America/Chicago' });
    expect(byId('tidy')).toMatchObject({ timeZone: null });
    const none = bodyOf(
      await list(vault({ ...files, '.atlas/automations/Morning brief.md': brief })),
    ) as { automations: Record<string, unknown>[] };
    expect(none.automations.find((automation) => automation['id'] === 'brief')).toMatchObject({
      timeZone: null,
    });
  });

  it('dry-runs it as the prompt and tools a run would use, over at most ten notes, asking no one', async () => {
    // A Claude step plans over note versions, which the index's manifest holds.
    const markdown = jsonMarkdown();
    const api = apiFixture({
      files,
      markdown,
      index: {
        query: atlasQueryIndex({ files, markdown }),
        manifest: async () =>
          Object.entries(files).map(([path, text]) => ({
            path,
            modified: 0,
            size: text.length,
            type: null,
            digest: digestOf(text),
          })),
      },
    });
    const before = new Map([...api.files].map(([path, note]) => [path, note.text]));

    const response = await dryRun(api, 'ask');

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      automation: { id: 'ask', name: 'Ask about tasks' },
      plan: {
        do: 'claude',
        set: null,
        claude: step,
        summary: 'Would ask Claude about 2 notes.',
        notes: [{ path: 'tasks/B.md' }, { path: 'tasks/C.md' }],
        cap: 10,
      },
    });
    expect(new Map([...api.files].map(([path, note]) => [path, note.text]))).toEqual(before);
  });

  describe('a step handed the weekly review, dry-run on a Tuesday (review of #539)', () => {
    const REVIEW = rule({
      id: 'friday',
      name: 'Friday review',
      when: 'fridays at 15:00',
      do: 'claude',
      prompt: '.atlas/prompts/friday-review.md',
      output: 'note',
      folder: 'Reviews',
      data: 'weekly-review',
    });
    const reviewFiles = {
      ...FILES,
      '.atlas/automations/Friday review.md': REVIEW,
      '.atlas/prompts/friday-review.md': 'Draft the review.\n',
    };

    it('says it would write its note, though it asks about no notes', async () => {
      const api = apiFixture({ files: reviewFiles, markdown: jsonMarkdown() });
      const response = await dryRun(api, 'friday');
      expect(bodyOf(response)).toMatchObject({
        plan: { do: 'claude', summary: 'Would write its note.', notes: [] },
      });
    });

    it('says the week’s note is made already when a note in its folder carries the week', async () => {
      const made = jsonNote({ atlas_period: '2026-09-25T15:00:00', atlas_period_rule: 'friday' });
      const api = apiFixture({
        files: { ...reviewFiles, 'Reviews/Weekly review.md': made },
        markdown: jsonMarkdown(),
      });
      const response = await dryRun(api, 'friday');
      expect(bodyOf(response)).toMatchObject({
        plan: { summary: expect.stringContaining('made already') },
      });
    });
  });

  it('lists and dry-runs a meeting extraction rule as output: meeting-items (P29-05)', async () => {
    const extraction = {
      ...files,
      '.atlas/automations/Extract.md': rule({
        id: 'extract',
        name: 'Extract',
        when: 'manually',
        which: 'FROM task WHERE status = done',
        do: 'claude',
        prompt: '.atlas/prompts/meeting-extraction.md',
        output: 'meeting-items',
      }),
    };
    const markdown = jsonMarkdown();
    const api = apiFixture({
      files: extraction,
      markdown,
      index: {
        query: atlasQueryIndex({ files: extraction, markdown }),
        manifest: async () =>
          Object.entries(extraction).map(([path, text]) => ({
            path,
            modified: 0,
            size: text.length,
            type: null,
            digest: digestOf(text),
          })),
      },
    });
    const claude = {
      prompt: '.atlas/prompts/meeting-extraction.md',
      tools: [],
      output: 'meeting-items',
      folder: null,
      data: null,
    };

    const { automations } = bodyOf(await list(api)) as { automations: Record<string, unknown>[] };
    const { plan } = bodyOf(await dryRun(api, 'extract')) as { plan: Record<string, unknown> };

    expect(automations.find((each) => each['id'] === 'extract')).toMatchObject({
      do: 'claude',
      claude,
    });
    expect(plan).toMatchObject({ do: 'claude', claude });
  });

  it('carries how often a Claude step asked and what it left out, from its log', async () => {
    const parts: LogEntry = {
      kind: 'run',
      at: '2026-09-21T03:00:04',
      trigger: 'hand',
      done: [],
      left: [],
      capped: false,
      claude: {
        model: 'claude-opus-5-5',
        ms: 900,
        asks: 3,
        dropped: [{ title: 'Order the cake', reason: 'Standup has no transcript turn ^t0099.' }],
      },
    };
    const api = vault({
      ...files,
      '.atlas/automations/log/ask.md': newLogText('Ask about tasks', [parts]),
    });

    const response = await api.send({ method: 'GET', path: '/v1/automations/ask/log' });

    expect(bodyOf(response)).toMatchObject({
      entries: [
        {
          kind: 'run',
          summary: 'Claude proposed nothing. Left out 1 item of the answer that did not read.',
          claude: {
            asks: 3,
            dropped: [
              { title: 'Order the cake', reason: 'Standup has no transcript turn ^t0099.' },
            ],
          },
        },
      ],
    });
  });

  it('reads the model a Claude step asked from its log', async () => {
    const asked: LogEntry = {
      kind: 'run',
      at: '2026-09-21T03:00:04',
      trigger: 'hand',
      done: [{ kind: 'created', path: 'Briefs/Brief.md' as never }],
      left: [],
      capped: false,
      claude: { model: 'claude-opus-5-5', ms: 900 },
    };
    const api = vault({
      ...files,
      '.atlas/automations/log/ask.md': newLogText('Ask about tasks', [asked]),
    });
    expect(bodyOf(await logOf(api, 'ask'))).toMatchObject({
      entries: [
        {
          kind: 'run',
          summary: 'Made 1 note.',
          done: [{ kind: 'created', path: 'Briefs/Brief.md' }],
          claude: { model: 'claude-opus-5-5', ms: 900 },
        },
      ],
    });
  });

  it('says which notes a Claude step read only the start of', async () => {
    const partly: LogEntry = {
      kind: 'run',
      at: '2026-09-21T03:00:04',
      trigger: 'note',
      done: [],
      left: [],
      capped: false,
      claude: {
        model: 'claude-opus-5-5',
        ms: 900,
        cut: [{ path: 'Meetings/Standup.md' as never, shown: 19874, of: 48211 }],
      },
    };
    const api = vault({
      ...files,
      '.atlas/automations/log/ask.md': newLogText('Ask about tasks', [partly]),
    });
    expect(bodyOf(await logOf(api, 'ask'))).toMatchObject({
      entries: [
        {
          summary:
            'Claude proposed nothing. 1 note was too long to read whole: Claude saw only the start.',
          claude: { cut: [{ path: 'Meetings/Standup.md', shown: 19874, of: 48211 }] },
        },
      ],
    });
  });

  it('lists what a Claude step cut off part-way had made, and cuts a long reason', async () => {
    const cut: LogEntry = {
      kind: 'failed',
      at: '2026-09-21T03:00:04',
      trigger: 'hand',
      problem: `Made 1 of 2 notes, then the write failed: ${'x'.repeat(2_000)}`,
      done: [{ kind: 'proposed', path: 'Inbox/Proposals/One.md' as never }],
      claude: { model: 'claude-opus-5-5', ms: 900 },
    };
    const api = vault({
      ...files,
      '.atlas/automations/log/ask.md': newLogText('Ask about tasks', [cut]),
    });
    const { entries } = bodyOf(await logOf(api, 'ask')) as {
      entries: { problem: string; done: unknown[] }[];
    };
    expect(entries[0]!.done).toEqual([{ kind: 'proposed', path: 'Inbox/Proposals/One.md' }]);
    expect(entries[0]!.problem.length).toBeLessThanOrEqual(600);
  });
});
