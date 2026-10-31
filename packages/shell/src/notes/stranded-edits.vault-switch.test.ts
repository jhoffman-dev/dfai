// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath, type EditorDocument } from '@dfai/domain';
import { useStrandedEdits } from './stranded-edits.ts';
import { memoryStrandedStore } from './testing/memory-stranded-store.ts';

/**
 * Adversarial: work the store could not hold lives only in the hook's memory.
 * The notice promises it is lost only "if DFAI quits first". A vault switch is
 * not a quit, and a stranding for a vault that is not open is not exempt from
 * "a refused write is reported rather than ignored".
 */

const NOTE = createVaultPath('Notes/today.md');
const VAULT = '/Users/someone/Vault';
const ANOTHER_VAULT = '/Users/someone/Other Vault';
const NOW = 1_700_000_000_000;

const doc = (text: string): EditorDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const stranding = (vault: string) => ({
  path: NOTE,
  doc: doc('Typed.'),
  reason: 'the note changed on disk since it was opened',
  modified: 5,
  vault,
});

function mount(vaultKey: string) {
  const { store } = memoryStrandedStore({ refuseWrites: true });
  return renderHook(
    ({ vaultKey: key }: { vaultKey: string | null }) =>
      useStrandedEdits({ store, vaultKey: key, now: () => NOW }),
    { initialProps: { vaultKey } },
  );
}

describe('work the store refused, across a vault switch', () => {
  it('is still handed back after switching away and back, since the app never quit', () => {
    const { result, rerender } = mount(VAULT);
    act(() => result.current.keep(stranding(VAULT)));
    // Precondition: it is held, in memory only.
    expect(result.current.notice).toContain('lost if DFAI quits');

    rerender({ vaultKey: ANOTHER_VAULT });
    rerender({ vaultKey: VAULT });

    expect(result.current.take(NOTE)?.doc).toEqual(doc('Typed.'));
  });

  it('is reported when it belongs to a vault that is no longer open', () => {
    const { result } = mount(ANOTHER_VAULT);

    act(() => result.current.keep(stranding(VAULT)));

    // The store said no and nothing holds the work: someone has to be told.
    expect(result.current.notice).not.toBeNull();
  });
});

describe('the notice about work refused for a vault that is not open', () => {
  it('names the note and the vault, and is let go of once the work is settled there', () => {
    const { result, rerender } = mount(ANOTHER_VAULT);
    act(() => result.current.keep(stranding(VAULT)));

    expect(result.current.notice).toContain('today in Vault could not be saved or stored');
    // It is not this vault's note, so it is not offered here.
    expect(result.current.waiting).toEqual([]);

    rerender({ vaultKey: VAULT });
    act(() => void result.current.take(NOTE));
    act(() => result.current.settle({ vault: VAULT, path: NOTE }));
    rerender({ vaultKey: ANOTHER_VAULT });

    expect(result.current.notice).toBeNull();
  });

  it('is still given after the vault it was refused in is switched away from', () => {
    const { result, rerender } = mount(VAULT);
    act(() => result.current.keep(stranding(VAULT)));

    rerender({ vaultKey: ANOTHER_VAULT });

    expect(result.current.notice).toContain('today in Vault could not be saved or stored');
  });
});

describe('work handed over through a `keep` made under the vault that was switched away from', () => {
  it('is filed for that vault and not offered to the one open now', () => {
    const { result, rerender } = mount(VAULT);
    const keepUnderOld = result.current.keep;
    rerender({ vaultKey: ANOTHER_VAULT });
    // The pane closed by the switch strands after it: its closure's vault is
    // the old one, and so is the work's.
    act(() => keepUnderOld(stranding(VAULT)));

    expect(result.current.take(NOTE)).toBeNull();
    expect(result.current.waiting).toEqual([]);
    // It is still reported, as work for the other vault.
    expect(result.current.notice).toContain('Vault');
    rerender({ vaultKey: VAULT });
    expect(result.current.take(NOTE)?.doc).toEqual(doc('Typed.'));
  });
});
