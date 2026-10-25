/**
 * Adversarial tests for the assistant's drafting routes (P32-05, PR #549):
 * asking again about an unchanged meeting, the draft that outlives its 202,
 * and a refused spec's error body. Fictional vault in memory, scripted model.
 */
import { describe, expect, it } from 'vitest';
import { builtInPromptAt, MEETING_EXTRACTION_PROMPT } from '@dfai/domain';
import type { ClaudeStepPorts } from '../automations/claude-step.ts';
import { apiFixture, bodyOf, codeOf, OTHER_VAULT } from '../testing/api-fixture.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';

const TASK_TYPE = jsonLinesNote({
  name: 'task',
  properties: { status: { kind: 'select', options: ['inbox', 'done'] } },
});
const MEETING = 'Meetings/2026-10-01 Orchard planning.md';
const MEETING_NOTE = jsonLinesNote(
  { type: 'meeting', title: 'Orchard planning', date: '2026-10-01' },
  '# Orchard planning\n\n## Transcript\n\n**Mara Quill** 00:01\nI will order the saplings. ^t0001\n',
);
const ITEMS = [
  {
    type: 'text' as const,
    text: JSON.stringify({
      items: [
        {
          kind: 'task',
          title: 'Order the saplings',
          owner: 'Mara Quill',
          source_block: 't0001',
          confidence: 'high',
        },
      ],
    }),
  },
];

function vault() {
  return apiFixture({
    files: {
      '.atlas/types/task.md': TASK_TYPE,
      [MEETING]: MEETING_NOTE,
      [MEETING_EXTRACTION_PROMPT]: builtInPromptAt(MEETING_EXTRACTION_PROMPT)!.contents,
    },
    markdown: jsonLinesMarkdown(),
  });
}

const proposeTasks = (meeting: unknown) => ({
  method: 'POST' as const,
  path: '/v1/assistant/propose-tasks',
  body: { meeting },
});

/** Claude's answer held until `release`, so the route's wait runs out first and it answers 202. */
function heldClaude(claude: ReturnType<typeof fakeClaudeStepPorts>, fails = false) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let streamed: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => (streamed = resolve));
  const ports: ClaudeStepPorts = {
    ...claude,
    provider: () => ({
      ...claude.provider(),
      stream: async function* (request, signal) {
        try {
          await held;
          if (fails) throw new Error('the model went away');
          yield* claude.provider().stream(request, signal);
        } finally {
          streamed();
        }
      },
    }),
  };
  /** Resolves once the model has answered and every write that follows it has had its turn. */
  const settled = async () => {
    await answered;
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { ports, release: () => release(), settled };
}

async function answered202(
  api: ReturnType<typeof vault>,
  claude: { deadlines: AbortController[] },
) {
  const answering = api.send(proposeTasks(MEETING));
  await expect.poll(() => claude.deadlines.length).toBeGreaterThan(0);
  claude.deadlines[0]!.abort();
  const response = await answering;
  expect(response.status).toBe(202);
}

describe('POST /v1/assistant/propose-tasks under attack', () => {
  it('does not ask Claude again about a meeting unchanged since it was drafted', async () => {
    const api = vault();
    const claude = fakeClaudeStepPorts({ rounds: [ITEMS, ITEMS], selfName: 'Mara Quill' });
    api.claudeStep = claude;

    expect((await api.send(proposeTasks(MEETING))).status).toBe(200);
    await api.send(proposeTasks(MEETING));

    expect(claude.fake.requests).toHaveLength(1);
  });

  it('writes nothing once the vault it was asked in has closed, after its 202', async () => {
    const api = vault();
    const claude = fakeClaudeStepPorts({ rounds: [ITEMS], selfName: 'Mara Quill' });
    const held = heldClaude(claude);
    api.claudeStep = held.ports;
    await answered202(api, claude);

    api.open = OTHER_VAULT;
    held.release();

    await held.settled();
    expect(api.writes).toEqual([]);
  });

  it('can be asked again once a draft that failed after its 202 has stopped', async () => {
    const api = vault();
    const claude = fakeClaudeStepPorts({ rounds: [ITEMS, ITEMS], selfName: 'Mara Quill' });
    const held = heldClaude(claude, true);
    api.claudeStep = held.ports;
    await answered202(api, claude);
    held.release();
    await held.settled();

    api.claudeStep = claude;
    expect((await api.send(proposeTasks(MEETING))).status).toBe(200);
  });

  it('proposes nothing from a meeting deleted while Claude was drafting it', async () => {
    const api = vault();
    const claude = fakeClaudeStepPorts({ rounds: [ITEMS], selfName: 'Mara Quill' });
    const held = heldClaude(claude);
    api.claudeStep = held.ports;
    await answered202(api, claude);

    api.files.delete(MEETING);
    held.release();

    await held.settled();
    expect(api.writes.map(({ path }) => path)).toEqual([]);
  });
});

describe('POST /v1/assistant/make-dashboard under attack', () => {
  it('keeps a refused spec’s error body bounded however long the text it echoes', async () => {
    const api = vault();
    // Under the host's 1 MB body limit: 48 widgets, each an unknown kind of 20 000 characters.
    const widgets = Array.from({ length: 48 }, () => ({ kind: 'x'.repeat(20_000) }));

    const response = await api.send({
      method: 'POST',
      path: '/v1/assistant/make-dashboard',
      body: { spec: { kind: 'dashboard', name: 'Orchard', widgets } },
    });

    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(bodyOf(response)).length).toBeLessThan(64 * 1024);
  });
});
