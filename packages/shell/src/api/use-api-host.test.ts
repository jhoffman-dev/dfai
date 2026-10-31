// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { VaultLocation } from '@dfai/application';
import { useApiHost } from './use-api-host.ts';

const WORK: VaultLocation = { absolutePath: '/Users/j/Work', name: 'Work' };
const HOME: VaultLocation = { absolutePath: '/Users/j/Home', name: 'Home' };

describe('useApiHost', () => {
  it('answers with the vault and index as they are now, through the same object', () => {
    const view = renderHook((props) => useApiHost(props), {
      initialProps: { vault: WORK as VaultLocation | null, indexReady: false },
    });
    const host = view.result.current;
    expect(host.currentVault()).toEqual(WORK);
    expect(host.indexReady()).toBe(false);

    view.rerender({ vault: HOME, indexReady: true });

    expect(view.result.current).toBe(host);
    expect(host.currentVault()).toEqual(HOME);
    expect(host.indexReady()).toBe(true);
  });

  it('answers null once the vault is closed', () => {
    const view = renderHook((props) => useApiHost(props), {
      initialProps: { vault: WORK as VaultLocation | null, indexReady: true },
    });
    view.rerender({ vault: null, indexReady: false });
    expect(view.result.current.currentVault()).toBeNull();
  });
});
