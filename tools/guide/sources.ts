import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GuideSources } from './assemble.ts';

const GUIDE = join(import.meta.dirname, '..', '..', 'docs', 'guide');
/** The published page, which `pnpm guide:build` writes. */
export const GUIDE_PAGE = join(GUIDE, 'index.html');
/** The guide's sources: `page.html` and a `sections/` folder of one file per section. */
export const GUIDE_SOURCE = join(GUIDE, 'src');

const SECTION_FILE = /^(.+)\.html$/;

/**
 * Each section file's id, from its name. Anything else in the folder is an
 * error rather than skipped, since a skipped file is a section never published.
 * A link is refused too: it could pull a file from outside the repo into the
 * public page.
 */
async function sectionFiles(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    // Finder's .DS_Store and other hidden files are not guide content.
    if (entry.name.startsWith('.')) continue;
    const id = SECTION_FILE.exec(entry.name)?.[1];
    if (id === undefined || !entry.isFile()) {
      throw new Error(`guide sections: ${entry.name} is not a plain .html file`);
    }
    files.set(id, join(folder, entry.name));
  }
  return files;
}

/** The guide's frame and every section file under `source` (docs/guide/src by default). */
export async function readGuideSources(source = GUIDE_SOURCE): Promise<GuideSources> {
  const sections = new Map<string, string>();
  for (const [id, path] of await sectionFiles(join(source, 'sections'))) {
    sections.set(id, await readFile(path, 'utf8'));
  }
  return { page: await readFile(join(source, 'page.html'), 'utf8'), sections };
}
