// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  fakeBlockCalendar,
  fakeVaultFs,
  memoryBlockSyncRecords,
  recordingActivity,
  GoogleCalendarError,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useBlockSync, BLOCK_SYNC_INTERVAL_MS, type BlockSyncOptions } from './use-block-sync.ts';

const VAULT = '/Users/mara/Vault';
const CLIENT_ID = '123456789012-abcdef0123456789abcdef0123456789.apps.googleusercontent.com';
const CALENDAR = 'dfai-blocks@group.calendar.example.com';
const NOW = Date.parse('2026-10-25T16:00:00Z');
const BLOCKS_ON = `google_client_id: ${CLIENT_ID}\ngoogle_calendar: ${CALENDAR}\ngoogle_blocks: true`;
const BLOCK = 'Larkspur close block.md';
const MAKES_BLOCKS = 'https://www.googleapis.com/auth/calendar.app.created';
const READS_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function setUp({
  settings = BLOCKS_ON,
  block = '---\ntype: block\nstart: 2026-10-26T09:00\nend: 2026-10-26T10:00\n---\n',
  grant,
}: { settings?: string; block?: string; grant?: { scopes: string[] } } = {}) {
  const google = fakeBlockCalendar();
  const { records, kept } = memoryBlockSyncRecords();
  const activity = recordingActivity();
  const onWrote = vi.fn();
  const files = new Map([
    ['.atlas/settings.md', `---\n${settings}\n---\n`],
    [BLOCK, block],
  ]);
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
    writeTextFile: async ({ path, contents }) => {
      files.set(path, contents);
      return 1;
    },
  });
  const options: BlockSyncOptions = {
    blocks: {
      calendar: google.calendar,
      records,
      ...(grant === undefined
        ? {}
        : {
            connection: {
              status: async () => ({ connected: true, clientId: CLIENT_ID, scopes: grant.scopes }),
            },
          }),
    },
    fs,
    markdown: remarkMarkdown,
    index: {
      query: async (sql) =>
        sql.includes('blocks: to sync')
          ? { columns: ['path'], rows: [[BLOCK]], truncated: false }
          : { columns: [], rows: [], truncated: false },
    },
    clock: { today: () => '2026-10-25', now: () => NOW },
    timeZone: () => 'America/Los_Angeles',
    vaultKey: VAULT,
    indexReady: true,
    activity,
    onWrote,
  };
  const hook = renderHook((props: BlockSyncOptions) => useBlockSync(props), {
    wrapper: queryWrapper().wrapper,
    initialProps: options,
  });
  return { hook, google, kept, activity, onWrote, files, options };
}

const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('useBlockSync (#30)', () => {
  it('syncs a vault whose blocks sync once its index is ready, and says what it wrote', async () => {
    const { hook, google, activity, onWrote, files, kept } = setUp();
    await settle();
    expect(google.state.asked).toEqual([{ calendarId: CALENDAR, syncToken: null }]);
    expect(google.state.writes.map((write) => write.kind)).toEqual(['insert']);
    expect(files.get(BLOCK)).toContain('gcal_etag:');
    expect(onWrote).toHaveBeenCalledTimes(1);
    expect(activity.reports.map(({ message }) => message)).toEqual([
      'Blocks on Google Calendar: 1 block added.',
    ]);
    expect(hook.result.current).toMatchObject({ enabled: true, syncing: false, lastSyncAt: NOW });
    expect(kept.get(VAULT)?.calendarId).toBe(CALENDAR);
  });

  it('syncs again every fifteen minutes, by what changed, and on Sync now', async () => {
    const { hook, google } = setUp();
    await settle();
    await act(async () => vi.advanceTimersByTime(BLOCK_SYNC_INTERVAL_MS));
    await settle();
    expect(google.state.asked.at(-1)).toEqual({ calendarId: CALENDAR, syncToken: 'blocks-sync-1' });
    act(() => hook.result.current.syncNow());
    await settle();
    expect(google.state.asked).toHaveLength(3);
  });

  it('never asks the host anything for a vault without the switch, a client and a calendar', async () => {
    for (const settings of [
      `google_client_id: ${CLIENT_ID}\ngoogle_calendar: ${CALENDAR}`,
      `google_calendar: ${CALENDAR}\ngoogle_blocks: true`,
      `google_client_id: ${CLIENT_ID}\ngoogle_blocks: true`,
    ]) {
      const { hook, google } = setUp({ settings });
      await settle();
      act(() => hook.result.current.syncNow());
      await settle();
      expect(google.state.asked).toEqual([]);
      expect(hook.result.current.enabled).toBe(false);
      hook.unmount();
    }
  });

  it('syncs nothing on a Mac that does not sync this vault’s blocks', async () => {
    const { hook, google, options } = setUp();
    hook.rerender({ ...options, blocks: null });
    await settle();
    expect(hook.result.current.enabled).toBe(false);
    // The first render may have started one sync; none after the host is taken away.
    const asked = google.state.asked.length;
    act(() => hook.result.current.syncNow());
    await settle();
    expect(google.state.asked).toHaveLength(asked);
  });

  it('never calls Google on a Mac whose sign-in may not write DFAI’s calendar', async () => {
    const { hook, google } = setUp({ grant: { scopes: [READS_EVENTS] } });
    await settle();
    act(() => hook.result.current.syncNow());
    await settle();
    expect(google.state.asked).toEqual([]);
  });

  it('after a 403 for the scope, the clock waits for the grant to change; Sync now still tries', async () => {
    const { hook, google } = setUp({ grant: { scopes: [MAKES_BLOCKS] } });
    google.state.failNext.list = new GoogleCalendarError({
      kind: 'api_refused',
      code: '403',
      message: 'the Calendar API answered 403: insufficientPermissions',
    });
    await settle();
    expect(hook.result.current.report?.scopeRefused).toBe(true);
    await act(async () => vi.advanceTimersByTime(BLOCK_SYNC_INTERVAL_MS));
    await settle();
    expect(google.state.asked).toHaveLength(1);
    act(() => hook.result.current.syncNow());
    await settle();
    expect(google.state.asked).toHaveLength(2);
  });

  it('says a warning in Activity once, not every quarter hour while it lasts', async () => {
    const { activity } = setUp({ block: '---\ntype: block\nstart: 2026-10-26T09:00\n---\n' });
    await settle();
    await act(async () => vi.advanceTimersByTime(BLOCK_SYNC_INTERVAL_MS));
    await settle();
    expect(activity.reports.map(({ level }) => level)).toEqual(['warning']);
    expect(activity.reports[0]?.subject).toEqual({ kind: 'note', path: BLOCK });
  });

  it('Stop ends a sync under way: nothing more is written', async () => {
    const { hook, google } = setUp();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = google.calendar.listBlockEvents;
    google.calendar.listBlockEvents = async (args) => {
      await held;
      return list(args);
    };
    await settle();
    act(() => hook.result.current.stop());
    release();
    await settle();
    expect(google.state.writes).toEqual([]);
  });
});
