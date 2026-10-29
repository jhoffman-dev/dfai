import { describe, expect, it } from 'vitest';
import type { SkillDraft } from '@dfai/domain';
import { ModelProviderError, type ModelEvent, type ModelProvider } from '../chat/ports.ts';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { draftSkill } from './draft-skill.ts';

const CURRENT: SkillDraft = {
  name: 'meeting-notes',
  description: 'Summarises a meeting’s notes for Tobias Fenn.',
  instructions: 'List the decisions, then the action items, then everything else said.',
};

const SHORTER = {
  name: 'meeting-notes',
  description: 'Summarises a meeting’s notes.',
  instructions: 'List the decisions and the action items.',
};

const said = (text: string): ModelEvent[] => [{ type: 'text', text }];

function ask(
  provider: ModelProvider,
  {
    current = CURRENT as SkillDraft | null,
    fixedName = 'meeting-notes' as string | null,
    signal = new AbortController().signal,
  } = {},
) {
  return draftSkill({
    provider,
    model: 'claude-opus-5-5',
    current,
    fixedName,
    request: 'Make this shorter.',
    signal,
  });
}

describe('draftSkill', () => {
  it('asks once with no tools, the request as the question and the skill fenced in the system prompt', async () => {
    const model = fakeModel([said(JSON.stringify(SHORTER))]);
    await expect(ask(model)).resolves.toEqual({
      kind: 'drafted',
      draft: SHORTER,
      ignoredName: null,
    });
    expect(model.requests).toHaveLength(1);
    const [request] = model.requests;
    expect(request?.tools).toEqual([]);
    expect(request?.model).toBe('claude-opus-5-5');
    expect(request?.messages).toEqual([{ role: 'user', text: 'Make this shorter.' }]);
    const fence = request?.system.slice(request.system.indexOf('<vault_data kind="skill">')) ?? '';
    expect(fence).toContain(CURRENT.instructions);
    expect(fence).toContain('</vault_data>');
  });

  it('drafts a new skill from nothing: no skill fenced, its name the answer’s', async () => {
    const drafted = { ...SHORTER, name: 'standup-notes' };
    const model = fakeModel([said('```json\n' + JSON.stringify(drafted) + '\n```')]);
    await expect(ask(model, { current: null, fixedName: null })).resolves.toEqual({
      kind: 'drafted',
      draft: drafted,
      ignoredName: null,
    });
    expect(model.requests[0]?.system).not.toContain('<vault_data kind');
  });

  it('keeps an existing skill’s name, and says which it ignored', async () => {
    const model = fakeModel([said(JSON.stringify({ ...SHORTER, name: 'notes-summary' }))]);
    await expect(ask(model)).resolves.toEqual({
      kind: 'drafted',
      draft: SHORTER,
      ignoredName: 'notes-summary',
    });
  });

  it('answers a bad draft with its problems, which change nothing', async () => {
    const model = fakeModel([said(JSON.stringify({ ...SHORTER, description: '<b>Bold</b>' }))]);
    await expect(ask(model)).resolves.toEqual({
      kind: 'refused',
      problems: ['A skill’s description cannot hold XML tags.'],
    });
  });

  it('runs no tool a model calls anyway: the call is refused and the next answer read', async () => {
    const call = { id: 'call-1', name: 'atlas_read_note', input: { path: 'Secret.md' } };
    const model = fakeModel([[{ type: 'tool_call', call }], said(JSON.stringify(SHORTER))]);
    await expect(ask(model)).resolves.toMatchObject({ kind: 'drafted', draft: SHORTER });
    const results = model.requests[1]?.messages.at(-1);
    expect(results).toMatchObject({ role: 'tool', results: [{ callId: 'call-1', isError: true }] });
  });

  it('says the provider’s own words and fix when Claude cannot be reached, and asks nothing', async () => {
    const model = fakeModel([]);
    const unready: ModelProvider = {
      ...model,
      status: async () => ({
        ready: false,
        problem: 'not_logged_in',
        message: 'Claude Code is not logged in.',
        fix: 'claude login',
      }),
    };
    await expect(ask(unready)).resolves.toEqual({
      kind: 'unready',
      message: 'Claude Code is not logged in.',
      fix: 'claude login',
    });
    expect(model.requests).toHaveLength(0);
  });

  it('treats a status that cannot be asked as an unreachable Claude', async () => {
    const broken: ModelProvider = {
      ...fakeModel([]),
      status: () => Promise.reject(new Error('no host')),
    };
    await expect(ask(broken)).resolves.toEqual({
      kind: 'unready',
      message: 'Error: no host',
      fix: null,
    });
  });

  it('says a provider’s failure in its words', async () => {
    const model = fakeModel([new ModelProviderError('failed', 'The model is overloaded.')]);
    await expect(ask(model)).resolves.toEqual({
      kind: 'failed',
      message: 'The model is overloaded.',
    });
  });

  it('lets any other failure through, unswallowed', async () => {
    const model = fakeModel([new TypeError('a bug')]);
    await expect(ask(model)).rejects.toThrow('a bug');
  });

  it('stops when Stop is pressed part-way, with no draft from what had arrived', async () => {
    const stop = new AbortController();
    const halfway: ScriptedRound = async function* () {
      yield { type: 'text', text: JSON.stringify(SHORTER) };
      stop.abort();
      yield { type: 'text', text: ' ' };
    };
    await expect(ask(fakeModel([halfway]), { signal: stop.signal })).resolves.toEqual({
      kind: 'stopped',
    });
  });

  it('stops before asking when Stop is pressed while the status is asked', async () => {
    const stop = new AbortController();
    const model = fakeModel([said(JSON.stringify(SHORTER))]);
    const slow: ModelProvider = {
      ...model,
      status: async () => {
        stop.abort();
        return { ready: true };
      },
    };
    await expect(ask(slow, { signal: stop.signal })).resolves.toEqual({ kind: 'stopped' });
    expect(model.requests).toHaveLength(0);
  });
});
