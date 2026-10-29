// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { apiFixture, fakeMarkdown, fakeSlack, type SlackCall } from '@dfai/application';
import {
  SLACK_PERMALINK,
  slackPermalinkAnswer,
  slackRepliesAnswer,
  slackUserAnswer,
} from '@dfai/domain/testing';
import { useSlackPaste, type SlackPastePorts } from './use-slack-paste.ts';
import { useSlackPasteListener } from './slack-paste-listener.ts';

/*
 * #105: a pasted Slack link, read through a fake host, offered, saved once.
 */

const answering = (call: SlackCall): unknown => {
  if (call.method === 'conversations.replies') return slackRepliesAnswer();
  if (call.method === 'chat.getPermalink') return slackPermalinkAnswer();
  return slackUserAnswer(call.query['user'] ?? '');
};

function setup({ hasToken = true, vault = '/vaults/larkspur' as string | null } = {}) {
  const api = apiFixture({ files: {} });
  const slack = fakeSlack(answering, { hasToken });
  const openNote = vi.fn();
  const ports: SlackPastePorts = {
    slack,
    capture: {
      fs: api.fs,
      markdown: fakeMarkdown(),
      index: { query: async () => ({ columns: [], rows: [], truncated: false }) },
    },
    vault,
    timeZone: () => 'UTC',
    openNote,
  };
  const hook = renderHook(() => useSlackPaste(ports));
  return { api, slack, openNote, hook };
}

describe('useSlackPaste', () => {
  it('ignores text that is not a Slack message link, asking Slack nothing', () => {
    const { slack, hook } = setup();
    let offered = true;
    act(() => {
      offered = hook.result.current.offer('see https://example.com');
    });
    expect(offered).toBe(false);
    expect(hook.result.current.view).toBeNull();
    expect(slack.calls).toEqual([]);
  });

  it('with no vault open, offers nothing', () => {
    const { hook } = setup({ vault: null });
    act(() => {
      expect(hook.result.current.offer(SLACK_PERMALINK)).toBe(false);
    });
    expect(hook.result.current.view).toBeNull();
  });

  it('reads the message, offers it, saves it as a task once, and opens it', async () => {
    const { api, hook, openNote } = setup();
    act(() => {
      hook.result.current.offer(SLACK_PERMALINK);
    });
    expect(hook.result.current.view).toEqual({ state: 'reading' });
    await waitFor(() => expect(hook.result.current.view?.state).toBe('ready'));
    expect(hook.result.current.view).toMatchObject({ author: 'Mara Quill', replies: 1 });

    act(() => hook.result.current.save('task'));
    await waitFor(() => expect(hook.result.current.view?.state).toBe('saved'));
    expect(hook.result.current.view).toEqual({ state: 'saved', outcome: 'written', kind: 'task' });
    expect(api.writes).toHaveLength(1);

    // A second press once saved neither saves again nor turns the offer back into a save under way.
    act(() => hook.result.current.save('task'));
    expect(hook.result.current.view).toEqual({ state: 'saved', outcome: 'written', kind: 'task' });
    expect(api.writes).toHaveLength(1);
    act(() => hook.result.current.open());
    expect(openNote).toHaveBeenCalledWith(api.writes[0]?.path);
  });

  it('without a token, says to connect Slack, with the way to Settings', async () => {
    const { hook } = setup({ hasToken: false });
    act(() => {
      hook.result.current.offer(SLACK_PERMALINK);
    });
    await waitFor(() => expect(hook.result.current.view?.state).toBe('problem'));
    expect(hook.result.current.view).toMatchObject({
      problem: 'Slack is not connected on this Mac.',
      inSettings: true,
    });
  });

  it('saves once when Save is pressed twice before the first save answers', async () => {
    const { api, hook } = setup();
    act(() => {
      hook.result.current.offer(SLACK_PERMALINK);
    });
    await waitFor(() => expect(hook.result.current.view?.state).toBe('ready'));
    act(() => {
      hook.result.current.save('task');
      hook.result.current.save('note');
    });
    await waitFor(() => expect(hook.result.current.view?.state).toBe('saved'));
    expect(hook.result.current.view).toEqual({ state: 'saved', outcome: 'written', kind: 'task' });
    expect(api.writes).toHaveLength(1);
  });

  it('shows and saves an offer only in the vault it was pasted in', async () => {
    const api = apiFixture({ files: {} });
    const ports = (vault: string): SlackPastePorts => ({
      slack: fakeSlack(answering),
      capture: {
        fs: api.fs,
        markdown: fakeMarkdown(),
        index: { query: async () => ({ columns: [], rows: [], truncated: false }) },
      },
      vault,
      timeZone: () => 'UTC',
      openNote: vi.fn(),
    });
    const hook = renderHook((vault: string) => useSlackPaste(ports(vault)), {
      initialProps: '/vaults/larkspur',
    });
    act(() => {
      hook.result.current.offer(SLACK_PERMALINK);
    });
    await waitFor(() => expect(hook.result.current.view?.state).toBe('ready'));
    hook.rerender('/vaults/other');
    expect(hook.result.current.view).toBeNull();
    await act(async () => {
      hook.result.current.save('task');
      for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    });
    expect(api.writes).toEqual([]);
    hook.rerender('/vaults/larkspur');
    expect(hook.result.current.view?.state).toBe('ready');
  });

  it('drops the answer to a paste dismissed before it arrived', async () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.offer(SLACK_PERMALINK);
    });
    act(() => hook.result.current.dismiss());
    // The fake host answers on microtasks: these turns are enough for every answer to arrive.
    await act(async () => {
      for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    });
    expect(hook.result.current.view).toBeNull();
  });
});

describe('useSlackPasteListener', () => {
  function paste(target: Element, text: string) {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    target.dispatchEvent(event);
    return event;
  }

  it('hands a paste into a note or quick capture on, leaving the paste itself alone', () => {
    const offer = vi.fn(() => true);
    renderHook(() => useSlackPasteListener(offer));
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const paragraph = editor.appendChild(document.createElement('p'));
    const capture = document.createElement('input');
    capture.setAttribute('data-paste-offers', '');
    document.body.append(editor, capture);

    expect(paste(paragraph, SLACK_PERMALINK).defaultPrevented).toBe(false);
    paste(capture, SLACK_PERMALINK);
    expect(offer.mock.calls).toEqual([[SLACK_PERMALINK], [SLACK_PERMALINK]]);
  });

  it('leaves a paste anywhere else alone', () => {
    const offer = vi.fn(() => true);
    renderHook(() => useSlackPasteListener(offer));
    const search = document.body.appendChild(document.createElement('input'));
    paste(search, SLACK_PERMALINK);
    expect(offer).not.toHaveBeenCalled();
  });
});
