// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ChatItem, ChatState } from '@dfai/application';
import { useAskState } from '../ask/use-ask-transcript.ts';

/**
 * Attack on PR #557 (#548): the sidebar reads each answer for citations as
 * it streams. AskAnswer is memoised on the answer it is handed, so a finished
 * answer is drawn again on every streamed word unless the reading hands it
 * back as the same object.
 */

const state = (items: readonly ChatItem[], busy: boolean): ChatState => ({
  items,
  busy,
  error: null,
  context: null,
  chatPath: null,
  notice: null,
});

describe('the sidebar chat while an answer streams (attack, PR #557)', () => {
  it('hands back a finished answer as the same object on every streamed word', () => {
    const finished: ChatItem[] = [
      { kind: 'user', id: 'u1', text: 'Who owns the rollback?' },
      { kind: 'assistant', id: 'a1', text: 'Mara Quill [[Rollback#^r1]].' },
      { kind: 'user', id: 'u2', text: 'And the cutover?' },
    ];
    const streaming = (text: string) =>
      state([...finished, { kind: 'assistant', id: 'a2', text }], true);
    const { result, rerender } = renderHook(({ chat }) => useAskState(chat), {
      initialProps: { chat: streaming('Tobias') },
    });
    const first = result.current.entries[1];
    for (const text of ['Tobias Fenn', 'Tobias Fenn owns', 'Tobias Fenn owns it.']) {
      rerender({ chat: streaming(text) });
      expect(result.current.entries[1]).toBe(first);
    }
  });
});
