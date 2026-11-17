import { describe, expect, it } from 'vitest';
import { noteWriteTurns } from './note-write-turns.ts';

/*
 * Attack on #883: many writes to one note, in seeded mixed orders, against a
 * store that refuses a write whose read is stale. Every write must read what
 * the one before it wrote, and the note must end holding exactly what the
 * writes, in order, make of it.
 */

/** Mulberry32: a seeded RNG so every order is reproducible. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op =
  | { kind: 'add'; id: string }
  | { kind: 'comment'; id: string; text: string }
  | { kind: 'remove'; id: string };

/** A note store whose write is refused when the text it was read from is not on disk. */
function staleRefusingNote() {
  let note = new Map<string, string>();
  let version = 0;
  const pause = (random: () => number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.floor(random() * 3)));
  return {
    current: () => note,
    async apply(op: Op, random: () => number) {
      const readVersion = version;
      const next = new Map(note);
      await pause(random);
      if (op.kind === 'add') next.set(op.id, '');
      else if (!next.has(op.id)) throw new Error(`no highlight ${op.id}`);
      else if (op.kind === 'comment') next.set(op.id, op.text);
      else next.delete(op.id);
      await pause(random);
      if (readVersion !== version) throw new Error('the note changed on disk since it was opened');
      note = next;
      version += 1;
    },
  };
}

function opsFor(random: () => number, count: number): Op[] {
  const live: string[] = [];
  const ops: Op[] = [];
  for (let at = 0; at < count; at += 1) {
    const roll = random();
    if (live.length === 0 || roll < 0.4) {
      const id = `h${at}`;
      live.push(id);
      ops.push({ kind: 'add', id });
    } else if (roll < 0.7) {
      ops.push({
        kind: 'comment',
        id: live[Math.floor(random() * live.length)] as string,
        text: `c${at}`,
      });
    } else {
      const [id] = live.splice(Math.floor(random() * live.length), 1);
      ops.push({ kind: 'remove', id: id as string });
    }
  }
  return ops;
}

function expected(ops: Op[]) {
  const note = new Map<string, string>();
  for (const op of ops) {
    if (op.kind === 'add') note.set(op.id, '');
    else if (op.kind === 'comment') note.set(op.id, op.text);
    else note.delete(op.id);
  }
  return note;
}

describe('attack #883: a note’s queued writes', () => {
  for (const seed of [1, 7, 42, 99, 2026, 31337]) {
    it(`2 to 20 mixed writes all land, in order, with none refused as stale (seed ${seed})`, async () => {
      const random = seeded(seed);
      for (let count = 2; count <= 20; count += 1) {
        const turns = noteWriteTurns();
        const store = staleRefusingNote();
        const ops = opsFor(random, count);
        const answers = await Promise.allSettled(
          ops.map((op) => turns.take('Library/Book.md', () => store.apply(op, random))),
        );
        expect(answers.filter((answer) => answer.status === 'rejected')).toEqual([]);
        expect([...store.current()].sort()).toEqual([...expected(ops)].sort());
        expect(turns.busy('Library/Book.md')).toBe(false);
      }
    });
  }

  it('carries on after a write that throws before returning a promise', async () => {
    const turns = noteWriteTurns();
    const thrown = turns.take('a.md', () => {
      throw new Error('synchronous');
    });
    const next = turns.take('a.md', async () => 'next');
    await expect(thrown).rejects.toThrow('synchronous');
    await expect(next).resolves.toBe('next');
    expect(turns.busy('a.md')).toBe(false);
  });

  it('holds no entry once a rejected write is the last one', async () => {
    const turns = noteWriteTurns();
    await expect(turns.take('a.md', async () => Promise.reject(new Error('no')))).rejects.toThrow(
      'no',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(turns.busy('a.md')).toBe(false);
  });
});
