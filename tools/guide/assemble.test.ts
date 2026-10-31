import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assembleGuide } from './assemble.ts';
import { GUIDE_PAGE, readGuideSources } from './sources.ts';

const section = (id: string, label: string, text = 'Some words.') =>
  `<!-- contents: ${label} -->\n    <section id="${id}">\n      <p>${text}</p>\n    </section>\n`;

const PAGE = [
  '<nav>',
  '<!-- guide:contents -->',
  '</nav>',
  '<main>',
  '<!-- guide:section start -->',
  '<!-- guide:section files -->',
  '</main>',
  '',
].join('\n');

const sources = (sections: Record<string, string>, page = PAGE) => ({
  page,
  sections: new Map(Object.entries(sections)),
});

describe('the field guide, assembled from its section files (#134)', () => {
  it('is the page committed as docs/guide/index.html — run `pnpm guide:build` if not', async () => {
    const committed = await readFile(GUIDE_PAGE, 'utf8');
    expect(assembleGuide(await readGuideSources())).toBe(committed);
  });

  it('fills the contents from the sections, in the order the page lists them', () => {
    const page = assembleGuide(
      sources({ files: section('files', 'Your files'), start: section('start', 'Start the app') }),
    );
    expect(page).toBe(
      [
        '<nav>',
        '    <a href="#start">Start the app</a>',
        '    <a href="#files">Your files</a>',
        '</nav>',
        '<main>',
        '    <section id="start">',
        '      <p>Some words.</p>',
        '    </section>',
        '',
        '    <section id="files">',
        '      <p>Some words.</p>',
        '    </section>',
        '</main>',
        '',
      ].join('\n'),
    );
  });

  it('refuses a section the page lists but no file holds', () => {
    expect(() => assembleGuide(sources({ start: section('start', 'Start') }))).toThrow(
      'guide section files is listed but has no file',
    );
  });

  it('refuses a section file the page does not list, which would never be published', () => {
    const all = {
      start: section('start', 'Start'),
      files: section('files', 'Files'),
      sync: section('sync', 'Sync'),
    };
    expect(() => assembleGuide(sources(all))).toThrow('not listed in the page: sync');
  });

  it('refuses a section listed twice', () => {
    const page = PAGE.replace('<!-- guide:section files -->', '<!-- guide:section start -->');
    expect(() => assembleGuide(sources({ start: section('start', 'Start') }, page))).toThrow(
      'guide section start is listed twice',
    );
  });

  it('refuses a section file with no contents label', () => {
    const files = section('files', 'Files').replace(/^<!--.*-->\n/, '');
    expect(() => assembleGuide(sources({ start: section('start', 'Start'), files }))).toThrow(
      'guide section files: first line must be <!-- contents: … -->',
    );
  });

  it('refuses a section file whose section has another id, so its contents link would be dead', () => {
    const files = section('files', 'Files').replace('id="files"', 'id="my-files"');
    expect(() => assembleGuide(sources({ start: section('start', 'Start'), files }))).toThrow(
      'must open with <section id="files">',
    );
  });

  it('refuses a section file that does not close its section', () => {
    const files = section('files', 'Files').replace('    </section>\n', '');
    expect(() => assembleGuide(sources({ start: section('start', 'Start'), files }))).toThrow(
      'must end with </section> and a newline',
    );
  });

  it('refuses a page with no place for the contents, or two', () => {
    const both = { start: section('start', 'Start'), files: section('files', 'Files') };
    const none = PAGE.replace('<!-- guide:contents -->\n', '');
    const twice = PAGE.replace('</nav>', '<!-- guide:contents -->\n</nav>');
    expect(() => assembleGuide(sources(both, none))).toThrow('must hold <!-- guide:contents -->');
    expect(() => assembleGuide(sources(both, twice))).toThrow('must hold <!-- guide:contents -->');
  });
});
