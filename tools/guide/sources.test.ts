import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGuideSources } from './sources.ts';

const SECTION = '<!-- contents: Start -->\n    <section id="start">\n    </section>\n';

let source = '';
let sections = '';

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), 'dfai-guide-sources-'));
  sections = join(source, 'sections');
  await mkdir(sections);
  await writeFile(join(source, 'page.html'), '<!-- guide:contents -->\n');
  await writeFile(join(sections, 'start.html'), SECTION);
});

afterEach(async () => {
  await rm(source, { recursive: true, force: true });
});

describe('the guide sources, read from their folder (#134)', () => {
  it('reads the frame and each section by the id its file is named for', async () => {
    const read = await readGuideSources(source);
    expect(read.page).toBe('<!-- guide:contents -->\n');
    expect([...read.sections]).toEqual([['start', SECTION]]);
  });

  it('passes over hidden files such as Finder’s .DS_Store', async () => {
    await writeFile(join(sections, '.DS_Store'), 'junk');
    expect([...(await readGuideSources(source)).sections.keys()]).toEqual(['start']);
  });

  it.each(['files.htm', 'files.HTML', 'notes.md'])(
    'refuses %s rather than skip a section that would never be published',
    async (name) => {
      await writeFile(join(sections, name), SECTION);
      await expect(readGuideSources(source)).rejects.toThrow(
        `guide sections: ${name} is not a plain .html file`,
      );
    },
  );

  it('refuses a folder in sections', async () => {
    await mkdir(join(sections, 'more.html'));
    await expect(readGuideSources(source)).rejects.toThrow('more.html is not a plain .html file');
  });

  it('refuses a section file that is a link, which could publish a file from outside the repo', async () => {
    const outside = join(source, 'outside.html');
    await writeFile(outside, SECTION);
    await symlink(outside, join(sections, 'linked.html'));
    await expect(readGuideSources(source)).rejects.toThrow('linked.html is not a plain .html file');
  });
});
