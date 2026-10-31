import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GuideSources } from './assemble.ts';

const GUIDE = join(import.meta.dirname, '..', '..', 'docs', 'guide');
/** The published page, which `pnpm guide:build` writes. */
export const GUIDE_PAGE = join(GUIDE, 'index.html');
const SOURCE = join(GUIDE, 'src');
const SECTIONS = join(SOURCE, 'sections');

/** The guide's frame and every section file under docs/guide/src. */
export async function readGuideSources(): Promise<GuideSources> {
  const files = (await readdir(SECTIONS)).filter((name) => name.endsWith('.html'));
  const sections = new Map<string, string>();
  for (const name of files) {
    sections.set(name.slice(0, -'.html'.length), await readFile(join(SECTIONS, name), 'utf8'));
  }
  return { page: await readFile(join(SOURCE, 'page.html'), 'utf8'), sections };
}
