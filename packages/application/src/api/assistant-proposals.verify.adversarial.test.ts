/**
 * Verify pass on PR #549: what a draft that outlived its 202 tells the person,
 * and the refused-spec bound on text that is not ASCII.
 */
import { describe, expect, it } from 'vitest';
import { builtInPromptAt, MEETING_EXTRACTION_PROMPT } from '@dfai/domain';
import type { ClaudeStepPorts } from '../automations/claude-step.ts';
import type { ModelEvent } from '../chat/ports.ts';
import { apiFixture, bodyOf } from '../testing/api-fixture.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';

const MEETING = 'Meetings/2026-10-01 Orchard planning.md';
const SECRET_LINE = 'The quince grafts are under the blue tarp.';
const MEETING_NOTE = jsonLinesNote(
  { type: 'meeting', title: 'Orchard planning', date: '2026-10-01' },
  `# Orchard planning\n\n## Transcript\n\n**Mara Quill** 00:01\n${SECRET_LINE} ^t0001\n`,
);
const ANSWER_SECRET = 'PLUM-LEDGER-4471';

function vault() {
  return apiFixture({
    files: {
      '.atlas/types/task.md': jsonLinesNote({ name: 'task', properties: {} }),
      [MEETING]: MEETING_NOTE,
      [MEETING_EXTRACTION_PROMPT]: builtInPromptAt(MEETING_EXTRACTION_PROMPT)!.contents,
    },
    markdown: jsonLinesMarkdown(),
  });
}

/** Claude's answer held until `release`, so the route answers 202 first. */
function heldClaude(claude: ClaudeStepPorts) {
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
          yield* claude.provider().stream(request, signal);
        } finally {
          streamed();
        }
      },
    }),
  };
  const settled = async () => {
    await answered;
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { ports, release: () => release(), settled };
}

describe('a draft that fails after its 202 (verify-549)', () => {
  it('names the meeting in its notice without the prompt, the transcript or the answer', async () => {
    const api = vault();
    const unreadable: ModelEvent[] = [
      { type: 'text', text: `Here you go: ${ANSWER_SECRET} {"items": "${ANSWER_SECRET}"}` },
    ];
    const claude = fakeClaudeStepPorts({ rounds: [unreadable], selfName: 'Mara Quill' });
    const held = heldClaude(claude);
    api.claudeStep = held.ports;
    const answering = api.send({
      method: 'POST',
      path: '/v1/assistant/propose-tasks',
      body: { meeting: MEETING },
    });
    await expect.poll(() => claude.deadlines.length).toBeGreaterThan(0);
    for (const deadline of claude.deadlines) deadline.abort();
    expect((await answering).status).toBe(202);

    held.release();
    await held.settled();

    expect(api.notices).toHaveLength(1);
    const [notice] = api.notices;
    expect(notice).toContain('Orchard planning');
    expect(notice).not.toContain(ANSWER_SECRET);
    expect(notice).not.toContain('quince');
    expect(notice).not.toContain('Only real commitments');
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe('POST /v1/assistant/make-dashboard bounds multibyte text (verify-549)', () => {
  it('never cuts a refused problem’s words through a surrogate pair', async () => {
    const api = vault();
    // Two offsets of the same emoji run, so one of them puts a pair across the cut.
    const widgets = [{ kind: '\u{1F34E}'.repeat(150) }, { kind: `a${'\u{1F34E}'.repeat(150)}` }];

    const response = await api.send({
      method: 'POST',
      path: '/v1/assistant/make-dashboard',
      body: { spec: { kind: 'dashboard', name: 'Orchard', widgets } },
    });

    const { problems } = (
      bodyOf(response) as { error: { problems: { at: string; message: string }[] } }
    ).error;
    expect(problems.length).toBeGreaterThan(0);
    for (const { at, message } of problems) {
      expect(LONE_SURROGATE.test(at)).toBe(false);
      expect(LONE_SURROGATE.test(message)).toBe(false);
    }
  });
});
