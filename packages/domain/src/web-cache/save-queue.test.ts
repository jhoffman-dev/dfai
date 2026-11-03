import { describe, expect, it } from 'vitest';
import {
  isProvisionalVersion,
  nextInQueue,
  queuedSaveKey,
  queueSave,
  savesToSend,
  type QueuedSave,
} from './save-queue.ts';

const VAULT = 'github:mara-quill/larkspur-vault#main';
const asked = (contents: string, expectedModified: number | null, path = 'Plan.md') => ({
  vault: VAULT,
  path,
  contents,
  expectedModified,
  expectedText: 'as read',
});

function queued(contents: string, expectedModified: number, provisional = -1): QueuedSave {
  const decision = queueSave(undefined, asked(contents, expectedModified), {
    order: 0,
    provisional,
  });
  if (decision.kind !== 'queued') throw new Error('not queued');
  return decision.save;
}

describe('queueSave', () => {
  it('queues a first save held to the version it started from, at a provisional version', () => {
    expect(queued('one', 7, -3)).toEqual({
      key: queuedSaveKey(VAULT, 'Plan.md'),
      vault: VAULT,
      path: 'Plan.md',
      contents: 'one',
      expectedModified: 7,
      expectedText: 'as read',
      order: 0,
      provisional: -3,
      refused: null,
    });
  });

  it('folds a save carrying on from the queued one into it, keeping its start and its turn', () => {
    const first = queued('one', 7, -1);
    const decision = queueSave(first, asked('two', -1), { order: 5, provisional: -2 });
    expect(decision).toEqual({
      kind: 'queued',
      save: { ...first, contents: 'two', provisional: -2 },
    });
  });

  it('keeps a refused save refused as later saves fold into it', () => {
    const refused = { ...queued('one', 7, -1), refused: 'the note changed on disk' };
    const decision = queueSave(refused, asked('two', -1), { order: 1, provisional: -2 });
    expect(decision.kind === 'queued' && decision.save.refused).toBe('the note changed on disk');
  });

  it('refuses as stale a save of a queued note that started from anything else', () => {
    const first = queued('one', 7, -1);
    expect(queueSave(first, asked('other pane', 7), { order: 1, provisional: -2 })).toEqual({
      kind: 'stale',
    });
    expect(queueSave(first, asked('older', -5), { order: 1, provisional: -2 }).kind).toBe('stale');
  });

  it('refuses as stale a save carrying on from a queued one that is gone', () => {
    expect(queueSave(undefined, asked('two', -1), { order: 0, provisional: -2 }).kind).toBe(
      'stale',
    );
  });

  it('queues a save of a new note, held to nothing', () => {
    const decision = queueSave(undefined, asked('new', null), { order: 0, provisional: -1 });
    expect(decision.kind === 'queued' && decision.save.expectedModified).toBeNull();
  });

  it('keeps no expected text where the save gave none', () => {
    const decision = queueSave(
      undefined,
      { vault: VAULT, path: 'A.md', contents: 'a', expectedModified: 1 },
      { order: 0, provisional: -1 },
    );
    expect(decision.kind === 'queued' && 'expectedText' in decision.save).toBe(false);
  });
});

describe('the order of the queue', () => {
  it('sends in the order first queued, leaving refused saves for the person', () => {
    const a = { ...queued('a', 1), key: 'a', order: 2 };
    const b = { ...queued('b', 1), key: 'b', order: 0 };
    const c = { ...queued('c', 1), key: 'c', order: 1, refused: 'moved' };
    const d = { ...queued('d', 1), key: 'd', order: 2 };
    expect(savesToSend([a, b, c, d]).map((save) => save.key)).toEqual(['b', 'a', 'd']);
  });

  it('gives the next save a turn and a provisional version past every one queued', () => {
    expect(nextInQueue([])).toEqual({ order: 0, provisional: -1 });
    const saves = [
      { ...queued('a', 1, -4), order: 3 },
      { ...queued('b', 1, -9), order: 1 },
    ];
    expect(nextInQueue(saves)).toEqual({ order: 4, provisional: -10 });
  });

  it('knows a provisional version from a blob version', () => {
    expect(isProvisionalVersion(-1)).toBe(true);
    expect(isProvisionalVersion(0)).toBe(false);
    expect(isProvisionalVersion(null)).toBe(false);
  });
});
