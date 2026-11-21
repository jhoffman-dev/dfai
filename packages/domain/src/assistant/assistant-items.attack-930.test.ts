import { describe, expect, it } from 'vitest';
import { reviewTask } from '../review/review-query.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { isOverdue } from '../review/weekly-review.ts';
import { loopTask, type ItemContext } from './assistant-items.ts';
import { linkingAmong } from './citation.ts';

/**
 * attack-930: one task due today at 09:00, asked about at 10:00. Today and
 * the weekly review call it overdue (#928); the assistant's open loops and
 * the brief, which read the same task, must not say it is not.
 */
const DAY = '2026-12-04';
const PATH = 'Tasks/Call Mara Quill.md';

const context: ItemContext = {
  ...linkingAmong([createVaultPath(PATH)]),
  sources: new Map(),
  hasBlock: () => false,
  day: DAY,
  // The wall time asked at, which the context carries from the clock (#928).
  time: '10:00',
};

describe('a timed due today whose time has passed (attack-930)', () => {
  it('is overdue to the assistant’s open loops as it is to Today and the review', () => {
    const review = reviewTask({
      path: PATH,
      title: 'Call Mara Quill',
      status: 'next-action',
      due: DAY,
      dueAt: `${DAY}T09:00`,
    });
    expect(isOverdue(review, { today: DAY, time: '10:00' })).toBe(true);

    const loop = loopTask({
      row: {
        path: PATH,
        title: 'Call Mara Quill',
        values: { status: 'next-action', due: `${DAY}T09:00` },
      },
      words: { key: 'status', done: 'done' },
      context,
    });
    expect(loop.overdue).toBe(true);
  });
});
