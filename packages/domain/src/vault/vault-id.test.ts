import { describe, expect, it } from 'vitest';
import { newVaultId, vaultIdOf } from './vault-id.ts';

describe('vaultIdOf', () => {
  it('reads text as written, none when absent or empty, and anything else as unreadable', () => {
    expect(vaultIdOf({ vault_id: ' k3v9q0m2b7hd5t1e ' })).toEqual({
      kind: 'id',
      id: 'k3v9q0m2b7hd5t1e',
    });
    expect(vaultIdOf({})).toEqual({ kind: 'none' });
    expect(vaultIdOf({ vault_id: null })).toEqual({ kind: 'none' });
    expect(vaultIdOf({ vault_id: '  ' })).toEqual({ kind: 'none' });
    expect(vaultIdOf({ vault_id: 42 })).toEqual({ kind: 'unreadable' });
    expect(vaultIdOf({ vault_id: ['a'] })).toEqual({ kind: 'unreadable' });
  });
});

describe('newVaultId', () => {
  it('is 16 characters of Google’s base32hex alphabet, one draw each', () => {
    const draws = [0, 0.5, 0.999_999, 1, -1];
    let at = 0;
    const id = newVaultId(() => draws[at++ % draws.length] ?? 0);
    expect(at).toBe(16);
    // 0 → 0, 0.5 → g, just under 1 → v; out of range is held inside it.
    expect(id).toBe('0gvv00gvv00gvv00');
    expect(id).toMatch(/^[0-9a-v]{16}$/);
  });
});
