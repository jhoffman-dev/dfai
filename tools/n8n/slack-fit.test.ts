import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_LENGTH, MAX_REPLIES, MAX_TOTAL_LENGTH } from '@dfai/domain';
import { fittedThread } from './slack-fit.ts';

/*
 * A thread fitted to capture/v1's limits (PR #623 attack): the saved
 * message whole, the replies farthest from it left out first.
 */

const SAVED_SECONDS = 1793136000;
const reply = (offsetSeconds: number, length: number) => ({
  ts: `${SAVED_SECONDS + offsetSeconds}.000100`,
  text: 'x'.repeat(length),
});
const saved = { ts: `${SAVED_SECONDS}.000100`, text: 'Can you send the renewal?' };

describe('a thread too long for a capture', () => {
  // 39,000 characters each: under Slack's own length, so only the total leaves any out.
  const SIZE = 39_000;
  const fits = Math.floor((MAX_TOTAL_LENGTH - saved.text.length) / SIZE);

  it('keeps the replies nearest the saved message, leaving out the farthest, in ts order', () => {
    // The saved message sits mid-thread: replies before it and after it.
    const offsets = Array.from({ length: fits + 6 }, (_, at) => (at - 10) * 60);
    const replies = offsets.map((offset) => reply(offset, SIZE));
    const kept = fittedThread(replies, saved);
    expect(kept).toHaveLength(fits);
    const keptOffsets = kept.map((each) => Number(each.ts.split('.')[0]) - SAVED_SECONDS);
    const farthestKept = Math.max(...keptOffsets.map(Math.abs));
    const left = offsets.filter((offset) => !keptOffsets.includes(offset));
    expect(left.every((offset) => Math.abs(offset) >= farthestKept)).toBe(true);
    expect(keptOffsets).toEqual([...keptOffsets].sort((a, b) => a - b));
  });

  it('leaves out the older of two replies equally far, on a tie', () => {
    const before = reply(-60, SIZE);
    const after = reply(60, SIZE);
    const filler = Array.from({ length: fits - 1 }, (_, at) => reply(1 + at, SIZE));
    const kept = fittedThread([before, ...filler, after], saved);
    expect(kept).toContain(after);
    expect(kept).not.toContain(before);
  });

  it('holds at most the contract’s number of replies, and none over Slack’s length', () => {
    const many = Array.from({ length: MAX_REPLIES + 5 }, (_, at) => reply(at + 1, 1));
    expect(fittedThread(many, saved)).toHaveLength(MAX_REPLIES);
    const long = reply(1, MAX_MESSAGE_LENGTH + 1);
    expect(fittedThread([long, reply(2, 5)], saved)).toEqual([reply(2, 5)]);
  });

  it('keeps every reply of a thread within the limits, as it came', () => {
    const replies = [reply(60, 10), reply(120, 10)];
    expect(fittedThread(replies, saved)).toEqual(replies);
  });
});
