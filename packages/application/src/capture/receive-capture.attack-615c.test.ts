import { describe, expect, it } from 'vitest';
import { CAPTURE_QUERY_MARK, readCapture, type VaultPath } from '@dfai/domain';
import { slackCapture, slackSource } from '@dfai/domain/testing';
import { apiFixture } from '../testing/api-fixture.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';
import type { QueryResult } from '../index/ports.ts';
import { receiveCapture } from './receive-capture.ts';

/*
 * Third attack on PR #615 (#103): the per-message lock. One message's
 * captures wait on each other; another message's never wait on them, even
 * on one that never settles, and a message once settled is free again. All
 * names are made up.
 */

const nothingIndexed = {
  query: async (sql: string): Promise<QueryResult> => ({
    columns: sql.startsWith(CAPTURE_QUERY_MARK) ? ['path'] : [],
    rows: [],
    truncated: false,
  }),
};

const messageAt = (ts: string) =>
  readCapture(
    slackCapture({
      text: `Message ${ts}`,
      thread: [],
      source: slackSource({
        ts,
        url: `https://larkspur.slack.com/archives/C0LARK5PUR/p${ts.replace('.', '')}`,
      }),
    }),
  );

/** A vault whose first write of one message's note never answers. */
function vaultStuckOn(stuck: string) {
  const api = apiFixture();
  let hung = false;
  const fs = {
    ...api.fs,
    createNote: (note: { path: VaultPath; contents: string }) => {
      if (hung || !note.contents.includes(stuck)) return api.fs.createNote(note);
      hung = true;
      return new Promise<never>(() => {});
    },
  };
  return { api, ports: { fs, markdown: fakeMarkdown(), index: nothingIndexed } };
}

/** Whether `promise` settles once every job queued so far has run. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
  return settled;
}

describe('one message’s captures wait on each other, and no other’s (third attack on PR #615)', () => {
  it('writes another message while one message’s write never answers', async () => {
    const { api, ports } = vaultStuckOn('Message 1793136000.000100');
    const stuck = receiveCapture({
      ports,
      capture: messageAt('1793136000.000100'),
      timeZone: 'UTC',
    });
    const other = receiveCapture({
      ports,
      capture: messageAt('1793136000.000200'),
      timeZone: 'UTC',
    });
    expect(await settlesSoon(other)).toBe(true);
    await expect(other).resolves.toMatchObject({ outcome: 'written' });
    expect(await settlesSoon(stuck)).toBe(false);
    expect([...api.files.keys()].filter((path) => path.startsWith('Inbox/Captures/'))).toHaveLength(
      1,
    );
  });

  it('holds a second capture of the stuck message behind the first', async () => {
    const { ports } = vaultStuckOn('Message 1793136000.000300');
    const capture = messageAt('1793136000.000300');
    const first = receiveCapture({ ports, capture, timeZone: 'UTC' });
    const second = receiveCapture({ ports, capture, timeZone: 'UTC' });
    // Unheld, the two would race, and whichever wrote second would settle.
    expect(await settlesSoon(Promise.race([first, second]))).toBe(false);
  });
});
