/**
 * Attack on PR #468 (UI v2 slice 15): proposal notices now pick a toast
 * tone. A toast drawn as 'change' (the green dot) says a change was made,
 * goes by itself, and is not kept in Activity — so it must never be what
 * says that nothing was made.
 */
import { describe, expect, it } from 'vitest';
import type { ToastRequest } from '../toasts/toasts.ts';
import { answeredNotice } from './answer-many.ts';
import { toastProposal } from './proposal-notice.ts';

function toneOf(notice: ReturnType<typeof answeredNotice>): ToastRequest['tone'] | undefined {
  const shown: ToastRequest[] = [];
  toastProposal({
    toasts: { show: (request) => (shown.push(request), shown.length) },
    notice,
    onOpen: () => {},
    onUndo: () => {},
  });
  return shown[0]?.tone;
}

describe('proposal toasts and their tone (attack-468)', () => {
  it('does not draw "none of them was accepted" as a change made', () => {
    const notice = answeredNotice('Accepted', {
      done: [],
      failed: [
        { item: 'Inbox/Proposals/a.md', reason: 'the note changed' },
        { item: 'Inbox/Proposals/b.md', reason: 'the note changed' },
      ],
    });
    expect(notice.text).toMatch(/^None of the 2 proposals was accepted/);
    expect(toneOf(notice)).not.toBe('change');
  });
});
