import { describe, expect, it } from 'vitest';
import { TODAY_KEYS, todayKeyActionOf, type TodayRowStanding } from './today-keys.ts';

/** #109: one key on a focused Today row does what one of the row's own controls does. */

const row = (standing: Partial<TodayRowStanding> = {}): TodayRowStanding => ({
  status: 'next-action',
  section: 'nextActions',
  choosing: true,
  focusIsOwn: false,
  ...standing,
});

describe('todayKeyActionOf', () => {
  it('ticks done on X, defers a day on D and opens Move to… on M, whatever the case', () => {
    expect(todayKeyActionOf('x', row())).toEqual({ kind: 'done' });
    expect(todayKeyActionOf('X', row())).toEqual({ kind: 'done' });
    expect(todayKeyActionOf('d', row())).toEqual({ kind: 'defer', days: 1 });
    expect(todayKeyActionOf('m', row())).toEqual({ kind: 'move-menu' });
  });

  it('chooses on T as the row’s Today button would: on, off, or kept where carried over', () => {
    expect(todayKeyActionOf('t', row())).toEqual({ kind: 'choice', choice: 'choose' });
    expect(todayKeyActionOf('t', row({ section: 'chosen' }))).toEqual({
      kind: 'choice',
      choice: 'unchoose',
    });
    expect(todayKeyActionOf('t', row({ section: 'carriedOver' }))).toEqual({
      kind: 'choice',
      choice: 'keep',
    });
  });

  it('makes no choice where the vault does not choose, or the focus is the person’s own', () => {
    expect(todayKeyActionOf('t', row({ choosing: false }))).toBeNull();
    expect(todayKeyActionOf('t', row({ focusIsOwn: true }))).toBeNull();
  });

  it('moves to Next, Waiting or Someday on N, W, S — never to the status the task has', () => {
    const waiting = row({ status: 'waiting', section: 'waiting' });
    expect(todayKeyActionOf('n', waiting)).toEqual({ kind: 'move', status: 'next-action' });
    expect(todayKeyActionOf('s', waiting)).toEqual({ kind: 'move', status: 'someday' });
    expect(todayKeyActionOf('w', waiting)).toBeNull();
    expect(todayKeyActionOf('n', row())).toBeNull();
    expect(todayKeyActionOf('w', row())).toEqual({ kind: 'move', status: 'waiting' });
  });

  it('refuses any other key: P has no picker here, and U, J, Enter are not the row’s acts', () => {
    for (const key of ['p', 'u', 'j', 'k', 'Enter', ' ', '', 'xx', 'ArrowDown']) {
      expect(todayKeyActionOf(key, row()), key).toBeNull();
    }
  });

  it('lists every key that acts, each giving an action somewhere', () => {
    const anywhere = [row(), row({ status: 'waiting' })];
    for (const key of TODAY_KEYS) {
      expect(
        anywhere.some((each) => todayKeyActionOf(key, each) !== null),
        key,
      ).toBe(true);
    }
  });
});
