// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserBlockSyncRecords } from './browser-block-sync-records.ts';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const VAULT = '/Users/mara/Vault';
const KEY = `atlas.block-sync:${VAULT}`;
const NONE = { calendarId: null, syncToken: null, agreed: {}, lastSyncAt: null };
const RECORD = {
  calendarId: 'dfai-blocks@group.calendar.example.com',
  syncToken: 'sync-3',
  agreed: {
    dfaiev1: { title: 'Larkspur close block', start: '2026-10-26T09:00', end: '2026-10-26T10:00' },
  },
  lastSyncAt: 1_761_314_400_000,
};

describe('browserBlockSyncRecords', () => {
  it('keeps each vault’s record on this Mac, across a reload', () => {
    expect(browserBlockSyncRecords.read(VAULT)).toEqual(NONE);
    browserBlockSyncRecords.write(VAULT, RECORD);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual(RECORD);
    expect(browserBlockSyncRecords.read(VAULT)).toEqual(RECORD);
    expect(browserBlockSyncRecords.read('/Users/mara/Other')).toEqual(NONE);
  });

  it('reads a record it cannot make sense of as none, and keeps only the agreed blocks it can read', () => {
    window.localStorage.setItem(KEY, 'not json');
    expect(browserBlockSyncRecords.read(VAULT)).toEqual(NONE);
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        ...RECORD,
        agreed: {
          ...RECORD.agreed,
          broken: { title: 1 },
          empty: { title: 'x', start: '', end: '' },
        },
        lastSyncAt: 'soon',
      }),
    );
    expect(browserBlockSyncRecords.read(VAULT)).toEqual({ ...RECORD, lastSyncAt: null });
  });

  it('reads as none, and writes nothing, where site data is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(browserBlockSyncRecords.read(VAULT)).toEqual(NONE);
    expect(() => browserBlockSyncRecords.write(VAULT, RECORD)).not.toThrow();
  });
});
