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
});
