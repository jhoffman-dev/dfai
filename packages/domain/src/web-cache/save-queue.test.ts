import { describe, expect, it } from 'vitest';
import {
  carriesOnAt,
  isProvisionalVersion,
  isUnsent,
  nextInQueue,
  queuedSaveKey,
  queueSave,
  savesToSend,
  type QueuedSave,
} from './save-queue.ts';

const VAULT = 'github:mara-quill/larkspur-vault#main';
const ACCOUNT = 'mara-quill';
const asked = (contents: string, expectedModified: number | null, path = 'Plan.md') => ({
  account: ACCOUNT,
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

const landed = (save: QueuedSave, at: number): QueuedSave => ({
  ...save,
  contents: '',
  state: { kind: 'landed', at },
});

describe('queueSave', () => {
  it('queues a first save, for its account, held to the version it started from', () => {
    expect(queued('one', 7, -3)).toEqual({
      key: queuedSaveKey(VAULT, 'Plan.md'),
      account: ACCOUNT,
      vault: VAULT,
      path: 'Plan.md',
      contents: 'one',
      expectedModified: 7,
      expectedText: 'as read',
      order: 0,
      provisional: -3,
      state: { kind: 'waiting' },
    });
  });

  it('folds a save carrying on from the waiting one into it, keeping its start and its turn', () => {
    const first = queued('one', 7, -1);
    const decision = queueSave(first, asked('two', -1), { order: 5, provisional: -2 });
    expect(decision).toEqual({
      kind: 'queued',
      save: { ...first, contents: 'two', provisional: -2 },
    });
  });

  it('keeps a refused save refused as later saves fold into it', () => {
    const refused: QueuedSave = {
      ...queued('one', 7, -1),
      state: { kind: 'refused', reason: 'moved' },
    };
    const decision = queueSave(refused, asked('two', -1), { order: 1, provisional: -2 });
    expect(decision.kind === 'queued' && decision.save.state).toEqual({
      kind: 'refused',
      reason: 'moved',
    });
  });

  it('starts a new save from where a sent one landed, when the edit carries on from it', () => {
    const sent = landed(queued('one', 7, -1), 11);
    const decision = queueSave(sent, asked('two', -1), { order: 1, provisional: -2 });
    expect(decision).toEqual({
      kind: 'queued',
      save: {
        ...sent,
        contents: 'two',
        expectedModified: 11,
        expectedText: undefined,
        order: 1,
        provisional: -2,
        state: { kind: 'waiting' },
      },
    });
  });

  it('starts a new save over a sent or settled one from a version GitHub had', () => {
    const sent = landed(queued('one', 7, -1), 11);
    const decision = queueSave(sent, asked('fresh', 11), { order: 1, provisional: -2 });
    expect(decision.kind === 'queued' && decision.save.expectedModified).toBe(11);
  });

  it('refuses as stale a save carrying on from one the person discarded', () => {
    const settled: QueuedSave = { ...queued('one', 7, -1), state: { kind: 'settled' } };
    expect(queueSave(settled, asked('two', -1), { order: 1, provisional: -2 }).kind).toBe('stale');
  });

  it('refuses as stale a save of a waiting note that started from anything else', () => {
    const first = queued('one', 7, -1);
    expect(queueSave(first, asked('other pane', 7), { order: 1, provisional: -2 }).kind).toBe(
      'stale',
    );
    expect(queueSave(first, asked('older', -5), { order: 1, provisional: -2 }).kind).toBe('stale');
  });

  it('refuses as stale a save carrying on from a waiting one that is not there', () => {
    expect(queueSave(undefined, asked('two', -1), { order: 0, provisional: -2 }).kind).toBe(
      'stale',
    );
  });

  it('refuses another account’s save of a note one account has waiting', () => {
    const first = queued('one', 7, -1);
    const other = { ...asked('two', -1), account: 'tobias-fenn' };
    expect(queueSave(first, other, { order: 1, provisional: -2 }).kind).toBe('stale');
  });

  it('keeps no expected text where the save gave none', () => {
    const decision = queueSave(
      undefined,
      { account: ACCOUNT, vault: VAULT, path: 'A.md', contents: 'a', expectedModified: 1 },
      { order: 0, provisional: -1 },
    );
    expect(decision.kind === 'queued' && 'expectedText' in decision.save).toBe(false);
  });
});

describe('the order of the queue', () => {
  it('sends the account’s waiting saves in the order first queued', () => {
    const a = { ...queued('a', 1), key: 'a', order: 2 };
    const b = { ...queued('b', 1), key: 'b', order: 0 };
    const c: QueuedSave = {
      ...queued('c', 1),
      key: 'c',
      order: 1,
      state: { kind: 'refused', reason: 'moved' },
    };
    const d = { ...queued('d', 1), key: 'd', order: 2 };
    const e = landed({ ...queued('e', 1), key: 'e', order: 0 }, 3);
    const f = { ...queued('f', 1), key: 'f', order: 0, account: 'tobias-fenn' };
    expect(savesToSend([a, b, c, d, e, f], ACCOUNT).map((save) => save.key)).toEqual([
      'b',
      'a',
      'd',
    ]);
  });

  it('never hands out a provisional version again, even once the queue has sent everything', () => {
    expect(nextInQueue([])).toEqual({ order: 0, provisional: -1 });
    const sent = landed({ ...queued('a', 1, -4), order: 3 }, 9);
    const settled: QueuedSave = { ...queued('b', 1, -9), order: 1, state: { kind: 'settled' } };
    expect(nextInQueue([sent, settled])).toEqual({ order: 4, provisional: -10 });
  });

  it('counts waiting and refused saves as unsent, and sent or settled ones not', () => {
    const save = queued('a', 1);
    expect(isUnsent(save)).toBe(true);
    expect(isUnsent({ ...save, state: { kind: 'refused', reason: 'moved' } })).toBe(true);
    expect(isUnsent(landed(save, 3))).toBe(false);
    expect(isUnsent({ ...save, state: { kind: 'settled' } })).toBe(false);
  });

  it('says where an edit carrying on from a sent save stands on GitHub', () => {
    const sent = landed(queued('a', 1, -4), 9);
    expect(carriesOnAt(sent, -4)).toBe(9);
    expect(carriesOnAt(sent, 9)).toBe(9);
    expect(carriesOnAt(queued('a', 1, -4), -4)).toBe(-4);
    expect(carriesOnAt(undefined, 5)).toBe(5);
    expect(carriesOnAt(undefined, null)).toBeNull();
  });

  it('knows a provisional version from a blob version', () => {
    expect(isProvisionalVersion(-1)).toBe(true);
    expect(isProvisionalVersion(0)).toBe(false);
    expect(isProvisionalVersion(null)).toBe(false);
  });
});
