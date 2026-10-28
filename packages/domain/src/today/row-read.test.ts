import { describe, expect, it } from 'vitest';
import { stillAsRead, taskAsRead } from './row-read.ts';

/** #111, #108: what a Today row takes its task to be, and whether it still is. */
const ROW = {
  status: 'next-action',
  due: '2026-10-30',
  defer: null,
  focus: '2026-10-28',
} as const;

describe('taskAsRead', () => {
  it('reads the status, and the first day of due, defer and focus', () => {
    expect(
      taskAsRead({
        status: ' next-action',
        due: '2026-10-30T09:00',
        focus: ['2026-10-28', '2026-10-29'],
      }),
    ).toEqual(ROW);
  });

  it('reads a task with none of them as null throughout', () => {
    expect(taskAsRead({ focus: 'soon' })).toEqual({
      status: null,
      due: null,
      defer: null,
      focus: null,
    });
  });
});

describe('stillAsRead', () => {
  const file = { status: 'next-action', due: '2026-10-30', focus: '2026-10-28' };

  it('holds while the file says what the row showed', () => {
    expect(stillAsRead({ row: ROW, properties: file })).toBe(true);
  });

  it('fails once the task was chosen for another day, or taken off, since the row read it', () => {
    expect(stillAsRead({ row: ROW, properties: { ...file, focus: '2026-10-29' } })).toBe(false);
    const unchosen = { status: file.status, due: file.due };
    expect(stillAsRead({ row: ROW, properties: unchosen })).toBe(false);
  });

  it('fails once its status, due or defer moved on', () => {
    expect(stillAsRead({ row: ROW, properties: { ...file, status: 'waiting' } })).toBe(false);
    expect(stillAsRead({ row: ROW, properties: { ...file, due: '2026-11-01' } })).toBe(false);
    expect(stillAsRead({ row: ROW, properties: { ...file, defer: '2026-11-01' } })).toBe(false);
  });
});
