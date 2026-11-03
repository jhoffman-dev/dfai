import { describe, expect, it, vi } from 'vitest';
import { signOutAndForget } from './sign-out.ts';

describe('signOutAndForget', () => {
  it('signs out and forgets everything the device kept', async () => {
    const order: string[] = [];
    await signOutAndForget({
      signOut: async () => void order.push('signed out'),
      forget: [async () => void order.push('cache'), async () => void order.push('index')],
    });
    expect(order).toEqual(['signed out', 'cache', 'index']);
  });

  it('still forgets when the sign-out fails, then says it failed', async () => {
    const forget = vi.fn(async () => {});
    const signingOut = signOutAndForget({
      signOut: async () => Promise.reject(new Error('offline')),
      forget: [forget],
    });
    await expect(signingOut).rejects.toThrow('offline');
    expect(forget).toHaveBeenCalled();
  });

  it('forgets the rest when one step fails, and names every failure', async () => {
    const index = vi.fn(async () => {});
    const signingOut = signOutAndForget({
      signOut: async () => Promise.reject(new Error('offline')),
      forget: [async () => Promise.reject(new Error('blocked')), index],
    });
    await expect(signingOut).rejects.toBeInstanceOf(AggregateError);
    expect(index).toHaveBeenCalled();
  });

  it('signs nothing out while saves wait, unless the person agrees to lose them', async () => {
    const signOut = vi.fn(async () => {});
    const forget = vi.fn(async () => {});
    const asked: number[] = [];
    const refusing = await signOutAndForget({
      signOut,
      forget: [forget],
      unsent: async () => 2,
      confirmLosing: async (count) => {
        asked.push(count);
        return false;
      },
    });
    expect(refusing).toBe('kept');
    expect(signOut).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    expect(await signOutAndForget({ signOut, forget: [forget], unsent: async () => 2 })).toBe(
      'kept',
    );
    const agreeing = await signOutAndForget({
      signOut,
      forget: [forget],
      unsent: async () => 2,
      confirmLosing: async () => true,
    });
    expect(agreeing).toBe('signed-out');
    expect(asked).toEqual([2]);
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when no save waits', async () => {
    const confirmLosing = vi.fn(async () => false);
    const outcome = await signOutAndForget({
      signOut: async () => {},
      forget: [],
      unsent: async () => 0,
      confirmLosing,
    });
    expect(outcome).toBe('signed-out');
    expect(confirmLosing).not.toHaveBeenCalled();
  });
});
