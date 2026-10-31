import { describe, expect, it } from 'vitest';
import { createPageHoldsByVault } from './page-holds.ts';

describe('createPageHoldsByVault', () => {
  it('keeps one hold per vault: the same key gives the same hold, another key a fresh one, and A’s comes back', () => {
    const holds = createPageHoldsByVault();
    const a = holds.of('/vaults/a');
    expect(holds.of('/vaults/a')).toBe(a);
    const b = holds.of('/vaults/b');
    expect(b).not.toBe(a);
    expect(b.inbox).not.toBe(a.inbox);
    expect(b.proposals).not.toBe(a.proposals);
    expect(b.today).not.toBe(a.today);
    expect(holds.of('/vaults/a')).toBe(a);
    expect(holds.of('/vaults/b')).toBe(b);
  });
});
