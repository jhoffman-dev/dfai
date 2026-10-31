import { describe, expect, it } from 'vitest';
import { createVaultPath, type EntryMove } from '@dfai/domain';
import { createMoveRelay } from './move-relay.ts';

const MOVE: EntryMove = { from: createVaultPath('A.md'), to: createVaultPath('Archive/A.md') };

describe('createMoveRelay', () => {
  it('passes a move to what it was pointed at last', () => {
    const relay = createMoveRelay();
    const first: EntryMove[] = [];
    const second: EntryMove[] = [];

    relay.point((move) => first.push(move));
    relay.point((move) => second.push(move));
    relay.follow(MOVE);

    expect(first).toEqual([]);
    expect(second).toEqual([MOVE]);
  });

  it('follows a move with nothing until it is pointed somewhere', () => {
    expect(() => createMoveRelay().follow(MOVE)).not.toThrow();
  });
});
