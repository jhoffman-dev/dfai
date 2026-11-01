import { describe, expect, it } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import type { NoteChange } from '@dfai/domain';
import type { ReadScope, VaultRead } from '@dfai/application';
import {
  createWindowQueryClient,
  scopedReadKey,
  scopedReadMeta,
  vaultReadKey,
} from './query-client.ts';
import { createReadInvalidator } from './read-invalidator.ts';

/** A window's cache with one vault's reads shown, counting how often each is read. */
function shownReads(
  vaults: readonly string[] = ['/one'],
  shown: readonly VaultRead[] = ['graph', 'tags', 'types', 'templates'],
) {
  const client = createWindowQueryClient();
  const reads = new Map<string, number>();
  const unsubscribes: (() => void)[] = [];
  for (const vault of vaults) {
    for (const read of shown) {
      const name = `${vault}:${read}`;
      const observer = new QueryObserver(client, {
        queryKey: vaultReadKey(vault, read),
        queryFn: async () => {
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return reads.get(name);
        },
      });
      unsubscribes.push(observer.subscribe(() => {}));
    }
  }
  const settledReads = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return Object.fromEntries(reads);
  };
  return { client, settledReads, stop: () => unsubscribes.forEach((stop) => stop()) };
}

describe('the window’s whole-vault reads, told what changed', () => {
  it('reads again at once only what it is told, of the vault it is told', async () => {
    const { client, settledReads, stop } = shownReads(['/one', '/two']);
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.invalidate('/one', ['types']);

    expect(await settledReads()).toEqual({
      '/one:graph': 1,
      '/one:tags': 1,
      '/one:types': 2,
      '/one:templates': 1,
      '/two:graph': 1,
      '/two:tags': 1,
      '/two:types': 1,
      '/two:templates': 1,
    });
    stop();
  });

  it('holds what the index changed until it has news, then reads each once', async () => {
    const { client, settledReads, stop } = shownReads();
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.invalidateWithIndex('/one', ['graph']);
    reads.invalidateWithIndex('/one', ['graph', 'tags']);
    expect((await settledReads())['/one:graph']).toBe(1);

    reads.indexMoved('/one');
    const after = await settledReads();
    expect(after['/one:graph']).toBe(2);
    expect(after['/one:tags']).toBe(2);
    expect(after['/one:types']).toBe(1);

    // News with nothing held reads nothing.
    reads.indexMoved('/one');
    expect((await settledReads())['/one:graph']).toBe(2);
    stop();
  });

  it('holds each vault’s reads for its own news', async () => {
    const { client, settledReads, stop } = shownReads(['/one', '/two']);
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.invalidateWithIndex('/one', ['graph']);
    reads.indexMoved('/two');
    expect((await settledReads())['/one:graph']).toBe(1);
    stop();
  });

  it('reads nothing for a change that touched nothing', async () => {
    const { client, settledReads, stop } = shownReads();
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.invalidate('/one', []);
    reads.invalidateWithIndex('/one', new Set<VaultRead>());
    reads.indexMoved('/one');

    expect(Object.values(await settledReads())).toEqual([1, 1, 1, 1]);
    stop();
  });

  it('drops a vault’s reads as it closes, and what was waiting for it', async () => {
    const { client, settledReads, stop } = shownReads();
    const reads = createReadInvalidator({ client });
    await settledReads();
    reads.invalidateWithIndex('/one', ['graph']);

    reads.forget('/one');

    expect(reads.waitingFor('/one').size).toBe(0);
    expect(client.getQueryCache().findAll({ queryKey: ['vault', '/one'] })).toEqual([]);
    stop();
  });

  it('drops a read already under way when told it changed, rather than joining it', async () => {
    const client = createWindowQueryClient();
    const answers: ((value: string) => void)[] = [];
    const observer = new QueryObserver(client, {
      queryKey: vaultReadKey('/one', 'types'),
      queryFn: () => new Promise<string>((resolve) => answers.push(resolve)),
    });
    const stop = observer.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answers).toHaveLength(1);

    createReadInvalidator({ client }).invalidate('/one', ['types']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answers).toHaveLength(2);
    answers[1]?.('after the save');
    answers[0]?.('before the save');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.getQueryData(vaultReadKey('/one', 'types'))).toBe('after the save');
    stop();
  });
});

describe('what is waiting', () => {
  it('is what the index changed, until it has news', () => {
    const reads = createReadInvalidator({ client: createWindowQueryClient() });

    reads.invalidateWithIndex('/one', ['graph']);
    reads.invalidateWithIndex('/one', ['tags']);
    expect([...reads.waitingFor('/one')].sort()).toEqual(['graph', 'tags']);
    expect([...reads.waitingFor('/two')]).toEqual([]);

    reads.indexMoved('/one');
    expect([...reads.waitingFor('/one')]).toEqual([]);
  });
});

describe('a read that failed', () => {
  it('is read again on the vault’s next news, and one that worked is not', async () => {
    const client = createWindowQueryClient();
    let typeReads = 0;
    let graphReads = 0;
    const failing = new QueryObserver(client, {
      queryKey: vaultReadKey('/one', 'types'),
      queryFn: async () => {
        typeReads += 1;
        if (typeReads === 1) throw new Error('the disk was busy');
        return 'types';
      },
    });
    const working = new QueryObserver(client, {
      queryKey: vaultReadKey('/one', 'graph'),
      queryFn: async () => (graphReads += 1),
    });
    const stops = [failing.subscribe(() => {}), working.subscribe(() => {})];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getQueryState(vaultReadKey('/one', 'types'))?.status).toBe('error');

    const reads = createReadInvalidator({ client });
    reads.indexMoved('/two');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(typeReads).toBe(1);

    reads.indexMoved('/one');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(typeReads).toBe(2);
    expect(client.getQueryData(vaultReadKey('/one', 'types'))).toBe('types');
    expect(graphReads).toBe(1);
    stops.forEach((stop) => stop());
  });

  it('reads the sidebar’s marks and counts again on every news of their vault', async () => {
    const shown: readonly VaultRead[] = [
      'sidebar-marks',
      'quick-counts',
      'type-counts',
      'settings',
    ];
    const { client, settledReads, stop } = shownReads(['/one', '/two'], shown);
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.indexMoved('/one');
    reads.indexMoved('/one');

    expect(await settledReads()).toEqual({
      '/one:sidebar-marks': 3,
      '/one:quick-counts': 3,
      '/one:type-counts': 3,
      '/one:settings': 1,
      '/two:sidebar-marks': 1,
      '/two:quick-counts': 1,
      '/two:type-counts': 1,
      '/two:settings': 1,
    });
    stop();
  });
});

/** A window's cache with one pane read per scope shown, each counting its reads. */
function shownPaneReads(scopes: Record<string, ReadScope>, failingFirst: readonly string[] = []) {
  const vault = '/one';
  const client = createWindowQueryClient();
  const reads = new Map<string, number>();
  const failing = new Set<string>(failingFirst);
  const stops = Object.entries(scopes).map(([name, scope]) =>
    new QueryObserver(client, {
      queryKey: scopedReadKey(vault, name),
      meta: scopedReadMeta(scope),
      queryFn: async () => {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        if (failing.has(name)) throw new Error(`${name} could not be read`);
        return reads.get(name);
      },
    }).subscribe(() => {}),
  );
  const settledReads = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return Object.fromEntries(reads);
  };
  return { client, failing, settledReads, stop: () => stops.forEach((stop) => stop()) };
}

const edited = (path: string, type: string | null = null): NoteChange => ({
  kind: 'changed',
  path,
  type,
  digest: 'b',
  before: 'a',
});

describe('the panes’ reads, judged by what they are made from (#325)', () => {
  const scopes: Record<string, ReadScope> = {
    recipes: { notes: ['Notes/Recipes.md'] },
    today: { types: ['task'] },
    graph: { facets: ['graph'] },
  };

  it('reads again, when the index has news, only the pane reads its notes touched', async () => {
    const { client, settledReads, stop } = shownPaneReads(scopes);
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.noteChanges('/one', [edited('Tasks/Buy flour.md', 'task')]);
    expect(await settledReads()).toEqual({ recipes: 1, today: 1, graph: 1 });
    reads.indexMoved('/one');

    expect(await settledReads()).toEqual({ recipes: 1, today: 2, graph: 1 });
    stop();
  });

  it('reads a pane read of a facet again when a write changed it, whatever note did', async () => {
    const { client, settledReads, stop } = shownPaneReads(scopes);
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.noteChanges('/one', [edited('Notes/Elsewhere.md')]);
    reads.invalidateWithIndex('/one', ['graph']);
    reads.indexMoved('/one');

    expect(await settledReads()).toEqual({ recipes: 1, today: 1, graph: 2 });
    stop();
  });

  it('reads every pane read again for news whose notes are not known, or with none heard', async () => {
    const { client, settledReads, stop } = shownPaneReads(scopes);
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.noteChanges('/one', [edited('Notes/Elsewhere.md')]);
    reads.indexMoved('/one', false);
    expect(await settledReads()).toEqual({ recipes: 2, today: 2, graph: 2 });

    reads.indexMoved('/one');
    expect(await settledReads()).toEqual({ recipes: 3, today: 3, graph: 3 });
    stop();
  });

  it('judges each news by the notes heard since the last, and none of another vault’s', async () => {
    const { client, settledReads, stop } = shownPaneReads(scopes);
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.noteChanges('/one', [edited('Notes/Recipes.md')]);
    reads.indexMoved('/one');
    reads.noteChanges('/two', [edited('Tasks/Buy flour.md', 'task')]);
    reads.noteChanges('/one', [edited('Notes/Elsewhere.md')]);
    reads.indexMoved('/one');

    expect(await settledReads()).toEqual({ recipes: 2, today: 1, graph: 1 });
    stop();
  });

  it('reads a pane read whose last read failed again on any news, touched or not', async () => {
    const { client, failing, settledReads, stop } = shownPaneReads(scopes, ['recipes']);
    const reads = createReadInvalidator({ client });
    await settledReads();

    failing.delete('recipes');
    reads.noteChanges('/one', [edited('Notes/Elsewhere.md')]);
    reads.indexMoved('/one');

    expect(await settledReads()).toEqual({ recipes: 2, today: 1, graph: 1 });
    stop();
  });

  it('forgets what it heard of a vault as it closes', async () => {
    const { client, settledReads, stop } = shownPaneReads(scopes);
    const reads = createReadInvalidator({ client });
    await settledReads();

    reads.noteChanges('/one', [edited('Notes/Elsewhere.md')]);
    reads.forget('/one');
    expect(client.getQueryCache().findAll({ queryKey: scopedReadKey('/one') })).toEqual([]);
    stop();
  });
});

describe('a scoped read that kept a way to refresh itself', () => {
  /** A read of the notes of one type, counting its whole reads, with a refresh that adds the changed paths. */
  function listedReads(refresh: () => Promise<unknown>) {
    const client = createWindowQueryClient();
    let wholeReads = 0;
    const observer = new QueryObserver(client, {
      queryKey: scopedReadKey('/one', 'listed'),
      queryFn: async () => ({ paths: [`whole ${++wholeReads}`] }),
      meta: scopedReadMeta({ types: ['literature'] }, false, refresh),
    });
    const stop = observer.subscribe(() => {});
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    const data = () => client.getQueryData<{ paths: string[] }>(scopedReadKey('/one', 'listed'));
    return { client, stop, settled, data, wholeReads: () => wholeReads };
  }

  it('is brought up to date from the notes that touched it, not read whole', async () => {
    const { client, stop, settled, data, wholeReads } = listedReads(async () => ({
      paths: ['refreshed'],
    }));
    await settled();
    const reads = createReadInvalidator({ client });

    reads.noteChanges('/one', [edited('Library/A.md', 'literature'), edited('Notes/B.md', 'note')]);
    reads.indexMoved('/one');
    await settled();

    expect(data()).toEqual({ paths: ['refreshed'] });
    expect(wholeReads()).toBe(1);
    stop();
  });

  it('is read whole when its refresh says it cannot, or fails, or the news does not say which notes', async () => {
    for (const refresh of [async () => null, () => Promise.reject(new Error('busy'))]) {
      const { client, stop, settled, wholeReads } = listedReads(refresh);
      await settled();
      const reads = createReadInvalidator({ client });
      reads.noteChanges('/one', [edited('Library/A.md', 'literature')]);
      reads.indexMoved('/one');
      await settled();
      expect(wholeReads()).toBe(2);
      stop();
    }
    const { client, stop, settled, wholeReads } = listedReads(async () => ({ paths: ['x'] }));
    await settled();
    createReadInvalidator({ client }).indexMoved('/one', false);
    await settled();
    expect(wholeReads()).toBe(2);
    stop();
  });

  it('is not read at all for news that is not of its type', async () => {
    const { client, stop, settled, wholeReads } = listedReads(async () => ({ paths: ['x'] }));
    await settled();
    const reads = createReadInvalidator({ client });
    reads.noteChanges('/one', [edited('Notes/B.md', 'note')]);
    reads.indexMoved('/one');
    await settled();
    expect(wholeReads()).toBe(1);
    stop();
  });
});
