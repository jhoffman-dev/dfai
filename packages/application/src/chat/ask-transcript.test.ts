/**
 * Ask (#37): a question answered with an assistant tool, and the answer read
 * for its citations — with the fake model, through the chat's own toolbox.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_PROFILE, type ToolCall } from '@dfai/domain';
import { apiFixture } from '../testing/api-fixture.ts';
import { assistantApi, ASSISTANT_TODAY, MARA } from '../testing/assistant-vault.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import {
  askTranscript,
  RECENT_QUESTIONS,
  recentQuestions,
  type AskEntry,
} from './ask-transcript.ts';
import { createChatSession, type ChatState } from './chat-session.ts';
import { createChatToolbox } from './toolbox.ts';

const BRIEF: ToolCall = {
  id: 'call-1',
  name: 'atlas_brief',
  input: { entity: MARA, date: ASSISTANT_TODAY },
};

const ANSWER =
  'Mara wants a rollback plan for the bank file [[Kickoff#^t0003]].\n\n' +
  'She is probably worried about the cut-over.';

function askSession(rounds: ScriptedRound[]) {
  const { api } = assistantApi();
  const model = fakeModel(rounds);
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;
  const chat = createChatSession({
    provider: () => model,
    model: () => 'claude-opus-5-5',
    profile: () => Promise.resolve(EMPTY_PROFILE),
    toolbox: () =>
      createChatToolbox({ api: api.deps, fs: api.fs, markdown: blockMarkdown(), newId }),
    clock: {
      today: () => ASSISTANT_TODAY,
      now: () => 0,
      localNow: () => `${ASSISTANT_TODAY}T09:00:00`,
    },
    vault: () => ({ fs: api.fs, notePaths: [] }),
    accept: () => Promise.reject(new Error('nothing to accept')),
    undo: () => Promise.resolve(),
    skill: () => Promise.resolve({ kind: 'missing' as const }),
    stamp: () => '2999-03-13 09:00',
    newId,
    activity: recordingActivity(),
  });
  return { chat, model };
}

const answersOf = (entries: readonly AskEntry[]) =>
  entries.flatMap((entry) => (entry.kind === 'answer' ? [entry] : []));

describe('askTranscript', () => {
  it('asks with an assistant tool, and marks the one paragraph that cites nothing', async () => {
    const { chat, model } = askSession([
      [{ type: 'tool_call', call: BRIEF }],
      [{ type: 'text', text: ANSWER }],
    ]);
    await chat.send('What does Mara want from me today?');

    // The model was offered the assistant tools, and the brief's citations reached it.
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['atlas_brief', 'atlas_open_loops', 'atlas_meeting_quotes']),
    );
    expect(JSON.stringify(model.requests[1]?.messages)).toContain('[[Kickoff#^t0004]]');

    const entries = askTranscript(chat.state());
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'tool', 'answer']);
    const [answer] = answersOf(entries);
    expect(answer?.checked).toBe(true);
    expect(answer?.uncited).toBe(1);
    expect(answer?.blocks.map((block) => block.citation)).toEqual(['cited', 'uncited']);
  });

  it('does not judge the answer still arriving, and judges it once the turn is done', () => {
    const busy: ChatState = {
      ...stateWith([
        { kind: 'user', id: 'u1', text: 'Q' },
        { kind: 'assistant', id: 'a1', text: 'Partly written' },
      ]),
      busy: true,
    };
    expect(answersOf(askTranscript(busy))[0]?.checked).toBe(false);
    expect(answersOf(askTranscript({ ...busy, busy: false }))[0]?.checked).toBe(true);
  });

  it('does not judge what the model says on its way to a tool, and judges the answer after it', async () => {
    const { chat } = askSession([
      [
        { type: 'text', text: 'Let me look her up.' },
        { type: 'tool_call', call: BRIEF },
      ],
      [{ type: 'text', text: ANSWER }],
    ]);
    await chat.send('What does Mara want from me today?');
    const entries = askTranscript(chat.state());
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'answer', 'tool', 'answer']);
    expect(answersOf(entries).map((answer) => answer.checked)).toEqual([false, true]);
  });

  it('keeps judging earlier answers while a later question is under way', () => {
    const busy: ChatState = {
      ...stateWith([
        { kind: 'user', id: 'u1', text: 'Q1' },
        { kind: 'assistant', id: 'a1', text: 'Done.' },
        { kind: 'user', id: 'u2', text: 'Q2' },
        { kind: 'assistant', id: 'a2', text: 'Arriving' },
      ]),
      busy: true,
    };
    expect(answersOf(askTranscript(busy)).map((answer) => answer.checked)).toEqual([true, false]);
  });

  it('hands back an answer unchanged when its text has not moved, and reads one that has', () => {
    const first = stateWith([
      { kind: 'assistant', id: 'a1', text: 'One [[A]].' },
      { kind: 'assistant', id: 'a2', text: 'Two' },
    ]);
    const before = askTranscript(first);
    const after = askTranscript(
      stateWith([
        { kind: 'assistant', id: 'a1', text: 'One [[A]].' },
        { kind: 'assistant', id: 'a2', text: 'Two [[B]]' },
      ]),
      before,
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(answersOf(after)[1]?.uncited).toBe(0);
  });

  it('passes every other item through as it is', () => {
    const tool = {
      kind: 'tool',
      id: 't1',
      label: 'Read Plan.md',
      state: 'done',
      detail: null,
    } as const;
    expect(askTranscript(stateWith([tool]))).toEqual([tool]);
  });
});

describe('recentQuestions', () => {
  it('lists at most RECENT_QUESTIONS of the chats', async () => {
    const files: Record<string, string> = {};
    for (let at = 0; at < RECENT_QUESTIONS + 2; at += 1) {
      files[`Chats/Question ${at}.md`] = '---\ntype: chat\n---\n\n## You\n\nQ\n';
    }
    const { fs } = apiFixture({ files });
    const found = await recentQuestions({ fs });
    expect(found).toHaveLength(RECENT_QUESTIONS);
  });

  it('is empty in a vault with no Chats folder', async () => {
    const { fs } = apiFixture({ files: { 'Plan.md': 'x' } });
    expect(await recentQuestions({ fs })).toEqual([]);
  });
});

function stateWith(items: ChatState['items']): ChatState {
  return {
    items,
    busy: false,
    error: null,
    context: null,
    skill: null,
    chatPath: null,
    notice: null,
  };
}
