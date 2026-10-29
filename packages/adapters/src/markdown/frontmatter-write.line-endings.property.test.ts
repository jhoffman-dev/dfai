/**
 * The frontmatter writer and a block's own line endings (#620): a block
 * whose lines end in a mix of CRLF and LF — and may hold a lone CR — keeps
 * every byte the change does not reach. Seeded (mulberry32), so every run
 * draws the same blocks and edits.
 */

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { updateFrontmatter } from './frontmatter-write.ts';

describe('a mixed block holding a lone CR (review of #620)', () => {
  it.each([
    ['a plain value', '---\r\na: 1\rx\nb: 2\r\nc: 3\n---\n', '---\r\na: 1\rx\nb: 2\r\nc: 5\n---\n'],
    [
      'a quoted value',
      '---\r\na: "1\rx"\nb: 2\r\nc: 3\n---\n',
      '---\r\na: "1\rx"\nb: 2\r\nc: 5\n---\n',
    ],
    ['a comment', '---\r\n# c\rd\nb: 2\r\nc: 3\n---\n', '---\r\n# c\rd\nb: 2\r\nc: 5\n---\n'],
  ])('keeps the line with it in %s, CR and all', (_label, frontmatter, written) => {
    expect(updateFrontmatter(frontmatter, { c: 5 })).toBe(written);
  });

  it('keeps the extra CR of a line ending CR CR LF', () => {
    expect(updateFrontmatter('---\r\na: 1\r\r\nb: 2\nc: 3\r\n---\n', { c: 4 })).toBe(
      '---\r\na: 1\r\r\nb: 2\nc: 4\r\n---\n',
    );
  });

  it('gives a changed key the ending of its own line when the one beside it goes', () => {
    expect(updateFrontmatter('---\na: 1\r\nb: 2\nc: 3\r\n---\n', { a: null, b: 9 })).toBe(
      '---\nb: 9\nc: 3\r\n---\n',
    );
  });
});

/** mulberry32: a seeded RNG. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Item {
  readonly key: string | null;
  readonly lines: readonly string[];
}

/** One entry of a block: a comment, a blank, a list, a literal, a quoted value with a lone CR, a scalar. */
function itemAt(random: () => number, at: number): Item {
  const roll = random();
  if (roll < 0.1) return { key: null, lines: [`# note ${at}`] };
  if (roll < 0.2) return { key: null, lines: [''] };
  if (roll < 0.35) return { key: `k${at}`, lines: [`k${at}:`, `  - x${at}`, `  - y${at}`] };
  if (roll < 0.45) return { key: `k${at}`, lines: [`k${at}: |`, `  l1-${at}`, `  l2-${at}`] };
  if (roll < 0.55) return { key: `k${at}`, lines: [`k${at}: "v${at}\rw"`] };
  return { key: `k${at}`, lines: [`k${at}: ${at * 10}`] };
}

/** A block, with each line's ending drawn — or all LF, for the run it is compared with. */
function blockOf(seed: number, mixed: boolean) {
  const random = seeded(seed);
  const endings = seeded(seed * 7919 + 1);
  const ending = () => (mixed && endings() < 0.5 ? '\r\n' : '\n');
  const items = Array.from({ length: 2 + Math.floor(random() * 8) }, (_, at) => itemAt(random, at));
  const opening = `---${ending()}`;
  const lines = items.flatMap((item) =>
    item.lines.map((text) => ({ key: item.key, text, ending: ending() })),
  );
  const closing = endings() < 0.5 ? `---${ending()}` : '---';
  const frontmatter = opening + lines.map(({ text, ending }) => text + ending).join('') + closing;
  return { random, items, lines, frontmatter };
}

function editsFor(random: () => number, items: readonly Item[]): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const { key } of items) {
    if (key === null) continue;
    const roll = random();
    if (roll < 0.15) changes[key] = null;
    else if (roll < 0.3) changes[key] = `v${Math.floor(random() * 1000)}`;
    else if (roll < 0.4) changes[key] = ['p', 'q', 'r'];
  }
  if (random() < 0.4) changes['new0'] = random() < 0.5 ? 'n0' : ['a', 'b'];
  return changes;
}

const inner = (frontmatter: string) =>
  frontmatter.replace(/^---\r?\n/, '').replace(/\r?\n?---(\r?\n)?$/, '');

/** What is wrong with one seed's write, or nothing. */
function problemsOf(seed: number): string[] {
  const { random, items, lines, frontmatter } = blockOf(seed, true);
  const changes = editsFor(random, items);
  if (Object.keys(changes).length === 0) return [];
  const written = updateFrontmatter(frontmatter, changes);
  const problems: string[] = [];
  const intended = { ...(parse(inner(frontmatter).replace(/\r\n/g, '\n')) as object) } as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete intended[key];
    else intended[key] = value;
  }
  let read: Record<string, unknown>;
  try {
    read = (parse(inner(written).replace(/\r\n/g, '\n')) ?? {}) as Record<string, unknown>;
  } catch {
    return [`seed ${seed}: written block cannot be read`];
  }
  if (JSON.stringify(read) !== JSON.stringify(intended)) problems.push('values');
  const allLf = updateFrontmatter(blockOf(seed, false).frontmatter, changes);
  if (inner(written).replace(/\r\n/g, '\n') !== inner(allLf)) problems.push('text');
  // A comment the writer takes away with the key under it is gone in the all-LF run too.
  const kept = new Set(inner(allLf).split('\n'));
  for (const line of lines) {
    if (line.text === '' || (line.key !== null && line.key in changes)) continue;
    if (!kept.has(line.text)) continue;
    if (!written.includes(line.text + line.ending)) problems.push(`ending of ${line.text}`);
  }
  if (updateFrontmatter(written, changes) !== written) problems.push('not idempotent');
  return problems.length === 0 ? [] : [`seed ${seed}: ${problems.join(', ')}`];
}

describe('updateFrontmatter on mixed line endings, as a property', () => {
  it('writes the intended values, keeps every untouched line’s bytes, and settles', () => {
    const broken: string[] = [];
    for (let seed = 1; seed <= 1500; seed += 1) broken.push(...problemsOf(seed));
    expect(broken.slice(0, 5)).toEqual([]);
  }, 120_000);

  it('settles the review’s probe seed 48: a key made a scalar beside one deleted', () => {
    const frontmatter =
      '---\r\nk0: 0\nk1:\n  - x1\n  - y1\r\n# note 2\r\nk3: 30\r\nk4: 40\n\r\n' +
      'k6: |\r\n  l1-6\n  l2-6\nk7: 70\r\n---\r\n';

    expect(updateFrontmatter(frontmatter, { k1: 'v71', k7: null })).toBe(
      '---\r\nk0: 0\nk1: v71\n# note 2\r\nk3: 30\r\nk4: 40\n\r\nk6: |\r\n  l1-6\n  l2-6\n---\r\n',
    );
  });

  it('settles the review’s probe seed 2637: a blank line the writer moves keeps its LF', () => {
    expect(updateFrontmatter('---\r\n\n# note 1\r\n---', { new1: 'n1' })).toBe(
      '---\r\n# note 1\r\n\nnew1: n1\r\n---',
    );
  });
});
