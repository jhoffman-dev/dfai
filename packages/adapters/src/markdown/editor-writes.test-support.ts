import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '@dfai/domain';
import { parseMarkdownBody, renderBlock, serializeMarkdownBody } from './markdown-blocks.ts';
import { ROUND_TRIP_CORPUS } from './round-trip-corpus.ts';
import { generatedDocument } from './writer-fuzz.test-support.ts';

/*
 * What the editor writes for a fixed set of notes (third attack on PR #615):
 * the round-trip corpus and the repo's own markdown each with every block
 * edited and written back, and 3,000 seeded documents saved afresh. Kept so a
 * change to the writer (the emphasis markers, #103) can be held to writing
 * every other note byte for byte as main did. Test support only.
 */

/** One note: its key, and short hashes of what went in and what the editor wrote. */
export interface EditorWrite {
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
export function editorWrites(root: URL): EditorWrite[] {
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
