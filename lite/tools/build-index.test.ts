import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildIndex, runSummary } from './build-index.ts';

let vault: string;

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(vault, path)), { recursive: true });
  await writeFile(join(vault, path), text);
}

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'lite-index-'));
  await put('People/Mara Quill.md', 'Mara leads payroll at Larkspur Payroll. #person\n');
  await put('Projects/Larkspur rollout.md', 'The ledger move. See [[Mara Quill]].\n');
  await put('.git/HEAD.md', 'not a note');
  await put('node_modules/pkg/README.md', 'not a note');
  await put('.dfai/lite/README.md', 'the checked-out writer, not a note');
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

describe('buildIndex', () => {
  it('writes _index/ from the vault notes, skipping .git, node_modules and dot folders', async () => {
    const run = await buildIndex(vault);
    expect(run).toMatchObject({ notes: 2, written: run.files, removed: 0 });
    const people = await readFile(join(vault, '_index/folders/People.md'), 'utf8');
    expect(people).toContain('People/Mara Quill.md | #person | ← 1: [[Larkspur rollout]]');
    const readme = await readFile(join(vault, '_index/README.md'), 'utf8');
    expect(readme).not.toContain('not a note');
    expect(readme).toContain('\n2 notes.\n');
  });

  it('rewrites nothing when nothing changed, and deletes stale index files and their folders', async () => {
    await put('_index/folders/Old/part-1.md', 'stale');
    await put('_index/meetings/2020-01.md', 'stale');
    const first = await buildIndex(vault);
    expect(first.removed).toBe(2);
    expect(await readdir(join(vault, '_index/folders'))).not.toContain('Old');
    const second = await buildIndex(vault);
    expect(second).toMatchObject({ written: 0, removed: 0 });
    expect(runSummary(second)).toBe(
      `Indexed 2 notes into ${second.files} files in _index/: 0 written, 0 removed.`,
    );
  });

  it('gives the same bytes on a second build of the same notes', async () => {
    await buildIndex(vault);
    const before = await readFile(join(vault, '_index/tags.md'), 'utf8');
    await rm(join(vault, '_index'), { recursive: true });
    await buildIndex(vault);
    expect(await readFile(join(vault, '_index/tags.md'), 'utf8')).toBe(before);
  });
});
