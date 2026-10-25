// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserMeetingSyncRecords } from './browser-meeting-sync-records.ts';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const VAULT = '/Users/mara/Vault';
const OTHER = '/Users/mara/Other';
const NONE = { calendars: {}, lastSyncAt: null };
const RECORD = {
  calendars: { primary: { syncToken: 'sync-7', fromDay: '2026-10-23' } },
  lastSyncAt: 1_761_314_400_000,
};
const KEY = `atlas.meeting-sync:${VAULT}`;

describe('browserMeetingSyncRecords', () => {
  it('keeps each vault’s record on this Mac, across a reload', () => {
    expect(browserMeetingSyncRecords.read(VAULT)).toEqual(NONE);
    browserMeetingSyncRecords.write(VAULT, RECORD);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual(RECORD);
    expect(browserMeetingSyncRecords.read(VAULT)).toEqual(RECORD);
    expect(browserMeetingSyncRecords.read(OTHER)).toEqual(NONE);
  });

  it('reads a record it cannot make sense of as none', () => {
    window.localStorage.setItem(KEY, 'not json');
    expect(browserMeetingSyncRecords.read(VAULT)).toEqual(NONE);
    window.localStorage.setItem(KEY, JSON.stringify(['a list']));
    expect(browserMeetingSyncRecords.read(VAULT)).toEqual(NONE);
  });

  it('keeps each calendar it can read and drops the rest', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        calendars: {
          primary: { syncToken: 'sync-7', fromDay: '2026-10-23' },
          team: { syncToken: '', fromDay: '2026-10-23' },
          ops: { syncToken: 'sync-8', fromDay: 'yesterday' },
          odd: 'sync-9',
        },
        lastSyncAt: 'this morning',
      }),
    );
    expect(browserMeetingSyncRecords.read(VAULT)).toEqual({
      calendars: { primary: { syncToken: 'sync-7', fromDay: '2026-10-23' } },
      lastSyncAt: null,
    });
  });

  it('reads none, and keeps going, where storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(browserMeetingSyncRecords.read(VAULT)).toEqual(NONE);
    expect(() => browserMeetingSyncRecords.write(VAULT, RECORD)).not.toThrow();
  });
});
