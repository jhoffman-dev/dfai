import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PROFILE, type ProfileState } from '@dfai/domain';
import { profileWhenKnown } from './profile-when-known.ts';

const ADA = { name: 'Ada Lovelace', preferredName: null };

describe('profileWhenKnown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hands over a profile already read at once', async () => {
    const source = profileWhenKnown({ waitMs: 1000 });
    source.set(ADA);
    await expect(source.get()).resolves.toEqual(ADA);
  });

  it('the first question waits for the first read, and gets the name it finds', async () => {
    const source = profileWhenKnown({ waitMs: 1000 });
    const got: ProfileState[] = [];
    void source.get().then((profile) => got.push(profile));

    await vi.advanceTimersByTimeAsync(400);
    expect(got).toEqual([]);
    source.set(ADA);
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([ADA]);
  });

  it('a read that is still unknown after the wait is handed over as unknown', async () => {
    const source = profileWhenKnown({ waitMs: 1000 });
    const got: ProfileState[] = [];
    void source.get().then((profile) => got.push(profile));

    await vi.advanceTimersByTimeAsync(999);
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toEqual(['unknown']);
  });

  it('only the first question waits: later ones are handed what is known now', async () => {
    const source = profileWhenKnown({ waitMs: 1000 });
    const first = source.get();
    source.set(EMPTY_PROFILE);
    await expect(first).resolves.toEqual(EMPTY_PROFILE);

    source.set('unknown');
    await expect(source.get()).resolves.toBe('unknown');
  });
});
