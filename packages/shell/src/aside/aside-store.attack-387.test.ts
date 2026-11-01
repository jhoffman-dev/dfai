// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import {
  createAsideStore,
  focusRow,
  loadVaultAside,
  selectAsideTab,
  toggleAside,
  toggleClaude,
} from './aside-store.ts';
import { browserAsideStore } from './browser-aside-store.ts';

// Attack pass on PR #387: the remembered aside, per vault, under a hostile localStorage.

describe('browserAsideStore under a refusing localStorage (attack #387)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('guard: a write the storage refuses neither throws nor changes what the session holds', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const aside = createAsideStore({ remembered: browserAsideStore });
    loadVaultAside(aside, '/Vaults/Larkspur');
    expect(() => toggleAside(aside)).not.toThrow();
    expect(aside.getState().open).toBe(true);
  });

  it('guard: a read the storage refuses opens as a first run', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const aside = createAsideStore({ remembered: browserAsideStore });
    loadVaultAside(aside, '/Vaults/Larkspur');
    expect(aside.getState()).toMatchObject({ open: false, tab: 'properties' });
  });

  it('guard: an array, a number or JSON null under the key opens as a first run', () => {
    for (const stored of [
      '[true,"claude"]',
      '7',
      'null',
      '"claude"',
      '{"open":1,"tab":"claude"}',
    ]) {
      window.localStorage.setItem('atlas.aside:/v', stored);
      expect(browserAsideStore.read('/v')).toBeNull();
    }
  });

  it('guard: two vaults keep their own state across switches, and a change in one never writes the other', () => {
    const aside = createAsideStore({ remembered: browserAsideStore });
    loadVaultAside(aside, '/Vaults/Larkspur');
    toggleClaude(aside);
    loadVaultAside(aside, '/Vaults/Café Ölmühle');
    expect(aside.getState()).toMatchObject({ open: false, tab: 'properties' });
    selectAsideTab(aside, 'outline');
    loadVaultAside(aside, '/Vaults/Larkspur');
    expect(aside.getState()).toMatchObject({ open: true, tab: 'claude' });
    loadVaultAside(aside, '/Vaults/Café Ölmühle');
    expect(aside.getState()).toMatchObject({ open: false, tab: 'outline' });
  });

  it('guard: a vault switch drops the old vault’s focused rows, so tab t1 there is not t1 here', () => {
    const aside = createAsideStore({ remembered: browserAsideStore });
    loadVaultAside(aside, '/Vaults/Larkspur');
    focusRow(aside, {
      tab: 't1',
      path: createVaultPath('People/Mara Quill.md'),
      within: 'type:person',
    });
    loadVaultAside(aside, '/Vaults/Other');
    expect(aside.getState().rows.size).toBe(0);
  });
});
