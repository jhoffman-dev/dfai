import { renderMarkdown } from './render-markdown.ts';

const resolves = (target: string) => target === 'Mara Quill';

function rendered(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(markdown, { resolves });
  return host;
}

describe('the rendered view', () => {
  it('removes scripts and event handlers a note carries', () => {
    const host = rendered(
      'Hi <script>window.hacked = true</script>\n\n<img src="x" onerror="window.hacked = true">\n\n<a href="javascript:alert(1)">x</a>',
    );
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect(host.querySelector('a')?.getAttribute('href') ?? '').not.toMatch(/javascript/i);
    expect(host.innerHTML).not.toMatch(/hacked/);
  });

  it('draws wiki links as links, marking the ones no note answers', () => {
    const host = rendered('With [[Mara Quill|Mara]] and [[Materials list]].');
    const [mara, materials] = [...host.querySelectorAll<HTMLElement>('[data-wikilink]')];
    expect(mara?.textContent).toBe('Mara');
    expect(mara?.dataset['wikilink']).toBe('Mara Quill');
    expect(mara?.classList.contains('is-unresolved')).toBe(false);
    expect(materials?.classList.contains('is-unresolved')).toBe(true);
  });

  it('draws tags as links to the tags view, but not inside code', () => {
    const host = rendered('A #project/active note. `#not-a-tag`');
    const tags = [...host.querySelectorAll('a.tag-pill')];
    expect(tags.map((tag) => tag.getAttribute('href'))).toEqual(['#/tags/project%2Factive']);
    expect(host.querySelector('code')?.textContent).toBe('#not-a-tag');
  });

  it('shows task-list checkboxes, read-only', () => {
    const boxes = [...rendered('- [ ] open\n- [x] done\n').querySelectorAll('input')];
    expect(boxes.map((box) => [box.type, box.checked, box.disabled])).toEqual([
      ['checkbox', false, true],
      ['checkbox', true, true],
    ]);
  });

  it('opens an external link in a new tab, telling the site nothing', () => {
    const link = rendered('[site](https://example.com)').querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
