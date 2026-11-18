// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  apiFixture,
  ChatCancelled,
  createChatSession,
  createChatToolbox,
  fakeMarkdown,
  recordingActivity,
  type ModelEvent,
  type ModelProvider,
} from '@dfai/application';
import { EMPTY_PROFILE } from '@dfai/domain';
import { useStopWhenOff } from './use-chat.ts';

/*
 * #901: switching Ask and Claude chat off with a question still being
 * answered stops that turn, as the chat's own Stop does: nothing is asked of
 * Claude after, no late answer lands, and the conversation is kept for when
 * Ask comes back.
 */

/** A model whose one answer starts, then waits until it is told to go on or is cut off. */
function slowModel() {
  let goOn: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    goOn = resolve;
  });
  const provider: ModelProvider = {
    id: 'claude-code',
    status: async () => ({ ready: true }),
    async *stream(_request, signal): AsyncIterable<ModelEvent> {
      yield { type: 'text', text: 'Partly' };
      await Promise.race([
        waiting,
        new Promise((resolve) => signal.addEventListener('abort', resolve)),
      ]);
      if (signal.aborted) throw new ChatCancelled();
      yield { type: 'text', text: ' and the rest, too late' };
    },
  };
  return { provider, goOn };
}

function chatSession(provider: ModelProvider) {
  const fixture = apiFixture({ files: {} });
  const { fs } = fixture;
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;
  return createChatSession({
    provider: () => provider,
    model: () => 'claude-opus-5-5',
    profile: () => Promise.resolve(EMPTY_PROFILE),
    toolbox: () => createChatToolbox({ api: fixture.deps, fs, markdown: fakeMarkdown(), newId }),
    clock: { today: () => '2026-11-17', now: () => 0, localNow: () => '2026-11-17T09:00:00' },
    vault: () => ({ fs, notePaths: [] }),
    accept: () => Promise.reject(new Error('not here')),
    undo: () => Promise.reject(new Error('not here')),
    skill: () => Promise.resolve({ kind: 'missing' as const }),
    stamp: () => '2026-11-17 09:00',
    activity: recordingActivity(),
    newId,
  });
}

const words = (session: ReturnType<typeof chatSession>) =>
  session
    .state()
    .items.map((item) => (item.kind === 'user' || item.kind === 'assistant' ? item.text : ''));

describe('useStopWhenOff (#901)', () => {
  it('stops a turn in flight when Ask is switched off, keeping the conversation', async () => {
    const { provider, goOn } = slowModel();
    const session = chatSession(provider);
    const hook = renderHook(({ enabled }) => useStopWhenOff({ session, enabled }), {
      initialProps: { enabled: true },
    });
    const sent = session.send('What is due for Larkspur?');
    await act(async () => {});
    expect(session.state().busy).toBe(true);

    hook.rerender({ enabled: false });
    await act(async () => {
      goOn();
      await sent;
    });
    expect(session.state().busy).toBe(false);
    expect(words(session)).toEqual(['What is due for Larkspur?', 'Partly']);

    // Back on: the same conversation, nothing new asked or said.
    hook.rerender({ enabled: true });
    expect(words(session)).toEqual(['What is due for Larkspur?', 'Partly']);
  });

  it('leaves a turn alone while Ask stays on', async () => {
    const { provider, goOn } = slowModel();
    const session = chatSession(provider);
    const hook = renderHook(({ enabled }) => useStopWhenOff({ session, enabled }), {
      initialProps: { enabled: true },
    });
    const sent = session.send('What is due?');
    await act(async () => {});
    hook.rerender({ enabled: true });
    await act(async () => {
      goOn();
      await sent;
    });
    expect(words(session)).toEqual(['What is due?', 'Partly and the rest, too late']);
  });
});
