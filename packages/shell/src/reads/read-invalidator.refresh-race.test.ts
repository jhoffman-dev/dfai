import { describe, expect, it } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import type { NoteChange } from '@dfai/domain';
import { createWindowQueryClient, scopedReadKey, scopedReadMeta } from './query-client.ts';
import { createReadInvalidator } from './read-invalidator.ts';

/*
 * Regression, found verifying PR #525 (P3): a refresh in place starts from the value the
 * query held when it began. When a whole read of the same query is started
 * outside the refresh's queue (news whose notes are not known) and settles
 * first, the refresh must not put its older-based value over the newer one.
 */

const edited = (path: string, type: string | null): NoteChange => ({
  kind: 'changed',
  path,
  type,
  digest: 'b',
  before: 'a',
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a refresh in place racing a whole read of the same query (PR #525 regression)', () => {
  it('leaves the whole read that settled last in the cache, not a refresh begun before it', async () => {
    const client = createWindowQueryClient();
    const key = scopedReadKey('/one', 'listed');
    let wholeReads = 0;
    let finishRefresh: (value: unknown) => void = () => {};
    const refresh = (previous: { paths: string[] }) =>
      new Promise((resolve) => {
        finishRefresh = () => resolve({ paths: [...previous.paths, 'refreshed A'] });
      });
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => ({ paths: [`whole ${++wholeReads}`] }),
      meta: scopedReadMeta({ types: ['literature'] }, false, refresh as never),
    });
    const stop = observer.subscribe(() => {});
    await settled();
    const reads = createReadInvalidator({ client });

    // A literature note changed: the refresh begins from `whole 1` and waits on the index.
    reads.noteChanges('/one', [edited('Library/A.md', 'literature')]);
    reads.indexMoved('/one');
    await settled();
    // A build finished (notes not known): the query is read whole, and that read settles first.
    reads.indexMoved('/one', false);
    await settled();
    expect(client.getQueryData(key)).toEqual({ paths: ['whole 2'] });
    // Now the refresh begun from `whole 1` answers.
    finishRefresh(undefined);
    await settled();
    await settled();

    expect(client.getQueryData(key)).toEqual({ paths: ['whole 2'] });
    stop();
  });
});

describe('a refresh in place still under way when its vault closes (PR #525 regression)', () => {
  it('leaves nothing of the closed vault in the cache', async () => {
    const client = createWindowQueryClient();
    const key = scopedReadKey('/one', 'listed');
    let finishRefresh: () => void = () => {};
    const refresh = () =>
      new Promise((resolve) => {
        finishRefresh = () => resolve({ paths: ['refreshed A'] });
      });
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => ({ paths: ['whole 1'] }),
      meta: scopedReadMeta({ types: ['literature'] }, false, refresh as never),
    });
    const stop = observer.subscribe(() => {});
    await settled();
    const reads = createReadInvalidator({ client });
    reads.noteChanges('/one', [edited('Library/A.md', 'literature')]);
    reads.indexMoved('/one');
    await settled();

    // The window closes the vault while the refresh waits on the index.
    stop();
    reads.forget('/one');
    expect(client.getQueryCache().find({ queryKey: key })).toBeUndefined();
    finishRefresh();
    await settled();
    await settled();

    expect(client.getQueryCache().find({ queryKey: key })).toBeUndefined();
  });
});
