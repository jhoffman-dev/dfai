// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { browserAsideStore, parseRememberedAside } from './browser-aside-store.ts';

describe('browserAsideStore', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips a vault’s aside under its own key, and reads nothing for another vault', () => {
    browserAsideStore.write({ vaultKey: '/v', aside: { open: true, tab: 'outline' } });
    expect(window.localStorage.getItem('atlas.aside:/v')).not.toBeNull();
    expect(browserAsideStore.read('/v')).toEqual({ open: true, tab: 'outline' });
    expect(browserAsideStore.read('/other')).toBeNull();
  });

  it('reads a stale or hand-edited value as nothing remembered', () => {
    window.localStorage.setItem('atlas.aside:/v', 'not json');
    expect(browserAsideStore.read('/v')).toBeNull();
    window.localStorage.setItem('atlas.aside:/v', JSON.stringify({ open: 'yes', tab: 'outline' }));
    expect(browserAsideStore.read('/v')).toBeNull();
    window.localStorage.setItem('atlas.aside:/v', JSON.stringify({ open: true, tab: 'settings' }));
    expect(browserAsideStore.read('/v')).toBeNull();
  });

  it('parses only the four tabs with a boolean open', () => {
    expect(parseRememberedAside({ open: false, tab: 'claude' })).toEqual({
      open: false,
      tab: 'claude',
    });
    expect(parseRememberedAside(null)).toBeNull();
    expect(parseRememberedAside({ open: true })).toBeNull();
  });
});
