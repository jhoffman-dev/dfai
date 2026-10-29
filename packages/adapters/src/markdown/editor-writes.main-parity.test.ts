import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { editorWrites } from './editor-writes.test-support.ts';

/*
 * The editor writes every note as main did (third attack on PR #615, #103):
 * the emphasis markers changed so a run of bold or italic before a mail
 * address can no longer be read as part of it, and nothing else may. The
 * fixture holds main's writes at the branch's base (`base`), as short hashes
 * of each note's input and output: the round-trip corpus and the repo's own
 * markdown edited and written back, and 3,000 seeded documents saved. A note
 * whose input has changed since is not compared.
 */

interface Fixture {
  readonly base: string;
  readonly writes: readonly (readonly [key: string, input: string, output: string])[];
}

const FIXTURE = JSON.parse(
  readFileSync(new URL('editor-writes.main.json', import.meta.url), 'utf8'),
) as Fixture;

describe('the editor’s writes, against main’s', () => {
  it('are byte for byte main’s for every note main wrote that is unchanged', () => {
    const now = new Map(
      editorWrites(new URL('../../../../', import.meta.url)).map((write) => [write.key, write]),
    );
    const compared = FIXTURE.writes.filter(([key, input]) => now.get(key)?.input === input);
    const differ = compared
      .filter(([key, , output]) => now.get(key)?.output !== output)
      .map(([key]) => key);
    expect(differ).toEqual([]);
    // The seeded documents and the corpus never change: most of the fixture is always compared.
    expect(compared.length).toBeGreaterThan(3000);
  }, 300_000);
});
