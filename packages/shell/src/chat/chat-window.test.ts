import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { chatWindowOf } from './chat-window.ts';
import { chatStamp } from './use-chat.ts';

const note = createVaultPath('Plan.md');

describe('chatWindowOf', () => {
  it('is the query being written while the query page is open', () => {
    expect(chatWindowOf({ query: 'FROM task', focused: note })).toEqual({
      kind: 'query',
      text: 'FROM task',
    });
  });

  it('is the note the focused tab shows, or nothing while it shows a page', () => {
    expect(chatWindowOf({ query: null, focused: note })).toEqual({
      kind: 'path',
      path: 'Plan.md',
    });
    expect(chatWindowOf({ query: null, focused: null })).toEqual({ kind: 'none' });
  });
});

describe('chatStamp', () => {
  it('writes the time in the person’s own zone, to the minute', () => {
    const at = new Date(2026, 8, 7, 9, 5, 59).getTime();
    expect(chatStamp(at)).toBe('2026-09-07 09:05');
  });
});
