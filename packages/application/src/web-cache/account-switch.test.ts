import { describe, expect, it, vi } from 'vitest';
import { adoptAccount, AccountSwitchRefusedError } from './account-switch.ts';

describe('adoptAccount', () => {
  it('forgets nothing for the first account, or the same one signing in again', async () => {
    const forgetPrevious = vi.fn(async () => {});
    expect(await adoptAccount({ previous: null, signedInAs: 'mara-quill', forgetPrevious })).toBe(
      'same',
    );
    expect(
      await adoptAccount({ previous: 'mara-quill', signedInAs: 'mara-quill', forgetPrevious }),
    ).toBe('same');
    expect(forgetPrevious).not.toHaveBeenCalled();
  });

  it('forgets the previous account’s data before another account opens anything', async () => {
    const forgetPrevious = vi.fn(async () => {});
    expect(
      await adoptAccount({ previous: 'mara-quill', signedInAs: 'tobias-fenn', forgetPrevious }),
    ).toBe('switched');
    expect(forgetPrevious).toHaveBeenCalledTimes(1);
  });

  it('opens nothing for the new account while the old one’s saves wait, unless agreed', async () => {
    const forgetPrevious = vi.fn(async () => {});
    const refusing = adoptAccount({
      previous: 'mara-quill',
      signedInAs: 'tobias-fenn',
      forgetPrevious,
      unsent: async () => 2,
      confirmLosing: async () => false,
    });
    await expect(refusing).rejects.toBeInstanceOf(AccountSwitchRefusedError);
    expect(forgetPrevious).not.toHaveBeenCalled();
    const agreeing = await adoptAccount({
      previous: 'mara-quill',
      signedInAs: 'tobias-fenn',
      forgetPrevious,
      unsent: async () => 2,
      confirmLosing: async () => true,
    });
    expect(agreeing).toBe('switched');
    expect(forgetPrevious).toHaveBeenCalledTimes(1);
  });

  it('opens nothing when forgetting the previous account fails', async () => {
    const switching = adoptAccount({
      previous: 'mara-quill',
      signedInAs: 'tobias-fenn',
      forgetPrevious: async () => Promise.reject(new Error('blocked')),
    });
    await expect(switching).rejects.toThrow('blocked');
  });

  it('by default keeps saves it was not told it may lose', async () => {
    const forgetPrevious = vi.fn(async () => {});
    const switching = adoptAccount({
      previous: 'mara-quill',
      signedInAs: 'tobias-fenn',
      forgetPrevious,
      unsent: async () => 1,
    });
    await expect(switching).rejects.toThrow(/Sign in as mara-quill to send them/);
    expect(forgetPrevious).not.toHaveBeenCalled();
  });
});
