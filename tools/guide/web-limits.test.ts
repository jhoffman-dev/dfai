import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { platformLimits } from '@dfai/application';
import { capabilitiesLacking, WEB_CAPABILITIES } from '@dfai/domain';
import { WEB_LIMITS } from './build-guide.ts';
import { GUIDE_PAGE } from './sources.ts';
import { WEB_LIMITS_MARKER, withWebLimits } from './web-limits.ts';

const section = (id: string, body: string) =>
  `<!-- contents: ${id} -->\n    <section id="${id}">\n${body}\n    </section>\n`;
const sources = (sections: Record<string, string>) => ({
  page: '',
  sections: new Map(Object.entries(sections)),
});
const LIMITS = [
  { what: 'Syncing by git', why: 'Saves go to GitHub instead.' },
  { what: 'Sources <SQLite> & more', why: 'A page can’t read them.' },
];

describe('the guide’s list of what the web cannot do, filled in as it is built (#670)', () => {
  it('writes one item per limit at the marker’s indent, its text escaped', () => {
    const filled = withWebLimits(
      sources({ web: section('web', `      <ul>\n        ${WEB_LIMITS_MARKER}\n      </ul>`) }),
      LIMITS,
    );
    expect(filled.sections.get('web')).toBe(
      section(
        'web',
        [
          '      <ul>',
          '        <li><b>Syncing by git.</b> Saves go to GitHub instead.</li>',
          '        <li><b>Sources &lt;SQLite&gt; &amp; more.</b> A page can’t read them.</li>',
          '      </ul>',
        ].join('\n'),
      ),
    );
  });

  it('leaves the other sections as they are', () => {
    const other = section('start', '      <p>Hello.</p>');
    const filled = withWebLimits(
      sources({ start: other, web: section('web', WEB_LIMITS_MARKER) }),
      LIMITS,
    );
    expect(filled.sections.get('start')).toBe(other);
  });

  it('refuses a guide with no list, rather than publish the section without it', () => {
    expect(() => withWebLimits(sources({ web: section('web', '<ul></ul>') }), LIMITS)).toThrow(
      'in one section, not 0',
    );
  });

  it('refuses the list in two sections, or twice in one', () => {
    const marked = section('web', WEB_LIMITS_MARKER);
    expect(() => withWebLimits(sources({ web: marked, other: marked }), LIMITS)).toThrow(
      'in one section, not 2',
    );
    const twice = section('web', `${WEB_LIMITS_MARKER}\n${WEB_LIMITS_MARKER}`);
    expect(() => withWebLimits(sources({ web: twice }), LIMITS)).toThrow('more than once');
  });
});

/** The committed guide's list in its web section, as [what, why] pairs. */
async function publishedWebLimits(): Promise<[string, string][]> {
  const page = await readFile(GUIDE_PAGE, 'utf8');
  const web = /<section id="web">([\s\S]*?)<\/section>/.exec(page)?.[1] ?? '';
  const list = web.slice(web.lastIndexOf('<ul>'));
  const unescape = (text: string) =>
    text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  return [...list.matchAll(/<li><b>(.*?)\.<\/b> (.*?)<\/li>/g)].map(([, what = '', why = '']) => [
    unescape(what),
    unescape(why),
  ]);
}

describe('the published guide says what the capability map says the web lacks (#670)', () => {
  it('lists every limit Settings shows on the web, in the same order and words', async () => {
    const shown = platformLimits(WEB_CAPABILITIES).map((limit) => [limit.what, limit.why]);
    expect(await publishedWebLimits()).toEqual(shown);
    expect(WEB_LIMITS).toEqual(platformLimits(WEB_CAPABILITIES));
  });

  it('names one item for each capability the web lacks but saving as a commit', async () => {
    const lacking = capabilitiesLacking(WEB_CAPABILITIES).filter((name) => name !== 'saveAsCommit');
    expect(lacking).toContain('localApi');
    expect(await publishedWebLimits()).toHaveLength(lacking.length);
  });
});
