// Attack on PR #652 (#134): sources the assembler publishes with no complaint,
// though the page they make is wrong. Each was an `it.fails` until the assembler refused it.
import { describe, expect, it } from 'vitest';
import { assembleGuide } from './assemble.ts';

const section = (id: string, label: string, body = '      <p>Some words.</p>\n') =>
  `<!-- contents: ${label} -->\n    <section id="${id}">\n${body}    </section>\n`;

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

const assemble = (files: string, page = PAGE) =>
  assembleGuide({
    page,
    sections: new Map([
      ['start', section('start', 'Start the app')],
      ['files', files],
    ]),
  });

/** The page as published, or null when the assembler refused the sources. */
const publishedOrRefused = (files: string, page = PAGE): string | null => {
  try {
    return assemble(files, page);
  } catch {
    return null;
  }
};

describe('the field guide refuses sources that publish a broken page (attack #652)', () => {
  it('refuses a link to a section id no section has, as when a section is renamed', () => {
    // claude.html renamed to claude-chat.html leaves every `#claude` in other sections dead.
    const files = section(
      'files',
      'Your files',
      '      <p>See <a href="#claude">Claude</a>.</p>\n',
    );
    expect(() => assemble(files)).toThrow();
  });

  it('refuses an element id another section already uses as its anchor', () => {
    // The contents link "Start the app" may now land on this heading instead.
    const files = section('files', 'Your files', '      <h3 id="start">Start here</h3>\n');
    expect(() => assemble(files)).toThrow();
  });

  it('refuses a second section written <section> with no attributes', () => {
    const files = section(
      'files',
      'Your files',
      '      <p>Some words.</p>\n    </section>\n    <section>\n      <p>Stowaway.</p>\n',
    );
    expect(() => assemble(files)).toThrow('must hold one <section>');
  });

  it('refuses content after the section closes, published outside any section', () => {
    const files = section(
      'files',
      'Your files',
      '      <p>Some words.</p>\n    </section>\n    <p>Orphan text in main.</p>\n',
    );
    expect(() => assemble(files)).toThrow();
  });

  it('publishes a contents label as text, never as markup', () => {
    const page = publishedOrRefused(section('files', 'Pay </a><b>stubs</b> & <i>tax'));
    // Refusing the label is as good as escaping it; publishing it raw is not.
    if (page !== null) expect(page).toContain('Pay &lt;/a&gt;&lt;b&gt;stubs');
    expect(page ?? '').not.toContain('</a><b>stubs</b>');
  });

  it('refuses a contents label that is only spaces, an empty link in the contents', () => {
    expect(() => assemble(section('files', '   '))).toThrow();
  });

  it('refuses a section marker inside an HTML comment, whose section is listed but hidden', () => {
    const page = PAGE.replace(
      '<!-- guide:section files -->',
      '<!-- Parked until the files view ships:\n<!-- guide:section files -->\n-->',
    );
    expect(() => assemble(section('files', 'Your files'), page)).toThrow();
  });
});
