import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '@dfai/domain';
import { parseMarkdownBody, renderBlock, serializeMarkdownBody } from './markdown-blocks.ts';
import { ROUND_TRIP_CORPUS } from './round-trip-corpus.ts';
import { generatedDocument } from './writer-fuzz.test-support.ts';
import { describe, expect, it } from 'vitest';

/*
 * The editor writes every note as main did (third attack on PR #615, #103):
 * the emphasis markers changed so a run of bold or italic before a mail
 * address can no longer be read as part of it, and nothing else may. The
 * fixture holds main's writes at the branch's base (`base`), as short hashes
 * of each note's input and output: the round-trip corpus and the repo's own
 * markdown edited and written back, and 3,000 seeded documents saved. A note
 * whose input has changed since is not compared.
 */

/** One note: its key, and short hashes of what went in and what the editor wrote. */
interface EditorWrite {
  readonly key: string;
  readonly input: string;
  readonly output: string;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The body with every block parsed as the editor holds it and written back. */
const editedBack = (body: string) =>
  parseMarkdownBody(body)
    .doc.content.map((node) => renderBlock(node))
    .join('\n\n');

const SEEDS = 3000;

/** Every note's write, the repo's markdown read from the checkout at `root`. */
function editorWrites(root: URL): EditorWrite[] {
  const writes: EditorWrite[] = [];
  const add = (key: string, input: string, write: () => string) => {
    let output: string;
    try {
      output = write();
    } catch (error) {
      output = `threw ${String(error)}`;
    }
    writes.push({ key, input: hash(input), output: hash(output) });
  };
  for (const [label, markdown] of ROUND_TRIP_CORPUS)
    add(`corpus ${label}`, markdown, () => editedBack(markdown));
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const doc = generatedDocument(seed);
    add(`seed ${seed}`, JSON.stringify(doc), () =>
      serializeMarkdownBody({ originalBody: '', parsed: parseMarkdownBody(''), doc }),
    );
  }
  const files = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');
  for (const path of files) {
    const text = readFileSync(join(fileURLToPath(root), path), 'utf8');
    add(`file ${path}`, text, () => editedBack(splitFrontmatter(text).body));
  }
  return writes;
}

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
