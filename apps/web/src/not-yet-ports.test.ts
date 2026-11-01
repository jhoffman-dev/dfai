import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import type { IndexedNote } from '@dfai/application';
import { NO_GIT, NO_GOOGLE_CALENDAR, NO_GRANOLA, NO_SLACK, NOT_YET } from './not-yet-ports.ts';
import {
  sessionActivityStore,
  sessionIndex,
  sessionSyncFiles,
  sessionVaultStore,
} from './session-stores.ts';

const vault = '/sample';

describe('what the web stub cannot do yet (#656)', () => {
  it('reports each service not connected, and refuses to connect it out loud', async () => {
    expect((await NO_GOOGLE_CALENDAR.status({ vault })).connected).toBe(false);
    await expect(NO_GOOGLE_CALENDAR.connect({ vault, clientId: 'id', scopes: [] })).rejects.toThrow(
      NOT_YET,
    );
    expect((await NO_GRANOLA.status({ vault })).hasKey).toBe(false);
    await expect(NO_GRANOLA.setKey({ vault, key: 'k' })).rejects.toThrow(NOT_YET);
    expect((await NO_SLACK.status({ vault })).hasToken).toBe(false);
    await expect(NO_SLACK.connect({ vault, token: 't' })).rejects.toThrow(NOT_YET);
  });

  it('answers every git command as git does outside a repository', async () => {
    const answers = await Promise.all([NO_GIT.topLevel(), NO_GIT.status(), NO_GIT.push()]);
    expect(answers.map((answer) => answer.code)).toEqual([128, 128, 128]);
  });
});

describe('what the web stub keeps for the session (#656)', () => {
  it('keeps the vault it was told to remember', async () => {
    const store = sessionVaultStore({ absolutePath: '/sample', name: 'Sample' });
    await store.write({ absolutePath: '/other', name: 'Other' });
    expect(await store.read()).toEqual({ absolutePath: '/other', name: 'Other' });
  });

  it('keeps each vault’s Activity log apart, appended and replaced', async () => {
    const store = sessionActivityStore();
    await store.append({ vault, text: 'one ✓\n' });
    // In bytes, as the host counts: ✓ is three.
    expect(await store.append({ vault, text: 'two\n' })).toBe(12);
    await store.replace({ vault: '/other', text: 'kept' });
    expect(await store.read({ vault })).toBe('one ✓\ntwo\n');
    expect(await store.read({ vault: '/other' })).toBe('kept');
  });

  it('keeps the sync’s files, and forgets one written as nothing', async () => {
    const files = sessionSyncFiles();
    await files.write('journal.json', 'held');
    expect(await files.read('journal.json')).toBe('held');
    await files.write('journal.json', null);
    expect(await files.read('journal.json')).toBeNull();
  });

  it('keeps what it is told is indexed, and answers every query with nothing', async () => {
    const index = sessionIndex();
    expect((await index.open()).fresh).toBe(true);
    const path = createVaultPath('Welcome.md');
    // Only the manifest's fields: the rest of an indexed note is what this index never answers from.
    await index.put([
      { path, modified: 1, size: 2, digest: 'd', type: null } as unknown as IndexedNote,
    ]);
    expect((await index.manifest()).map((entry) => entry.path)).toEqual([path]);
    expect(await index.search('anything', 10)).toEqual([]);
    await index.remove([path]);
    expect(await index.manifest()).toEqual([]);
  });
});
