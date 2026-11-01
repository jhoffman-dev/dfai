// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import type { SyncController, SyncOptions } from './use-sync.ts';
import { createSyncStore, useSyncForRunners, type SyncStore } from './sync-store.ts';

/**
 * Attack on PR #419 (#326). `useSync` keys its settings by vault: on the
 * render a vault opens, the new vault's settings are not read, so its
 * `automationsHere` is false ("a Mac never runs a rule the settings give to
 * another in the moment before it has read them"). Here `useSync` is
 * replaced by exactly that: vault A runs the automations here, vault B has
 * not been read yet.
 */
vi.mock('./use-sync.ts', () => ({
  useSync: (options: SyncOptions): SyncController =>
    ({
      phase: { kind: 'unknown' },
      thisMac: options.vaultKey === '/a' ? 'this Mac' : null,
      settings: options.vaultKey === '/a' ? ({} as never) : null,
      automationsHere: options.vaultKey === '/a',
      syncedThisSession: new Set(),
      syncPulls: new Map(),
      pulledFiles: { standing: null, acts: async () => false },
      settle: async () => {},
    }) as unknown as SyncController,
}));

const { SyncRunner } = await import('./sync-container.tsx');

/** What a runner (automations, meeting import) acted with, as its effects saw it. */
function Runner({ store, vaultKey, seen }: { store: SyncStore; vaultKey: string; seen: string[] }) {
  const { automationsHere, macKnown } = useSyncForRunners(store, vaultKey);
  useEffect(() => {
    seen.push(`${vaultKey}:${automationsHere}:${macKnown}`);
  });
  return null;
}

function Window({ store, vaultKey, seen }: { store: SyncStore; vaultKey: string; seen: string[] }) {
  return (
    <>
      <SyncRunner store={store} {...({ vaultKey } as unknown as SyncOptions)} />
      <Runner store={store} vaultKey={vaultKey} seen={seen} />
    </>
  );
}

describe('runners never act on a new vault with the last vault’s sync (attack-419)', () => {
  it('no runner effect sees the vault just opened with the vault before’s automationsHere', () => {
    const store = createSyncStore();
    const seen: string[] = [];
    const view = render(<Window store={store} vaultKey="/a" seen={seen} />);
    expect(seen.at(-1)).toBe('/a:true:true');
    seen.length = 0;
    act(() => view.rerender(<Window store={store} vaultKey="/b" seen={seen} />));
    // Before #419, `useSync` sat in the same component as the runners' hooks, so
    // vault B's first effects saw B's own `automationsHere` (false).
    expect(seen).not.toContain('/b:true:true');
    expect(seen.at(-1)).toBe('/b:false:false');
  });
});
