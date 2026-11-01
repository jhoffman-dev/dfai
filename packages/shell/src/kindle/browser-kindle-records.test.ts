// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_KINDLE_SYNC_RECORD } from '@dfai/domain';
import { browserKindleRecords } from './browser-kindle-records.ts';

const KEY = 'atlas.kindle-sync';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('browserKindleRecords', () => {
  it('reads back what it wrote', () => {
    const record = {
      connected: true,
      lastHoldAt: 1_700_000_000_000,
      last: { at: 1_700_000_100_000, message: 'Nothing new from Kindle.', ok: true },
    };
    browserKindleRecords.write(record);
    expect(browserKindleRecords.read()).toEqual(record);
  });

  it('reads nothing kept, or a record edited by hand, as not connected', () => {
    expect(browserKindleRecords.read()).toEqual(NO_KINDLE_SYNC_RECORD);
    window.localStorage.setItem(KEY, '{"connected":"yes","lastHoldAt":"soon","last":{"at":1}}');
    expect(browserKindleRecords.read()).toEqual(NO_KINDLE_SYNC_RECORD);
    window.localStorage.setItem(KEY, 'not json');
    expect(browserKindleRecords.read()).toEqual(NO_KINDLE_SYNC_RECORD);
  });

  it('reads as none, and writes without throwing, where storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(browserKindleRecords.read()).toEqual(NO_KINDLE_SYNC_RECORD);
    expect(() =>
      browserKindleRecords.write({ ...NO_KINDLE_SYNC_RECORD, connected: true }),
    ).not.toThrow();
  });
});
