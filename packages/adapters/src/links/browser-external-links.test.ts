import { describe, expect, it } from 'vitest';
import { browserExternalLinks } from './browser-external-links.ts';

function setUp() {
  const opened: [string, string, string][] = [];
  const links = browserExternalLinks((url, target, features) => {
    opened.push([url, target, features]);
    return null;
  });
  return { links, opened };
}

describe('opening a link on the web (#774)', () => {
  it.each([
    ['https://docs.google.com/document/d/abc', 'https://docs.google.com/document/d/abc'],
    ['http://localhost:3000/x', 'http://localhost:3000/x'],
    [' https://example.com/a b ', 'https://example.com/a%20b'],
  ])('opens %s in a new tab with no way back to this page', async (url, expected) => {
    const { links, opened } = setUp();
    await links.open(url);
    expect(opened).toEqual([[expected, '_blank', 'noopener,noreferrer']]);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<p>hi</p>',
    'mailto:mara@example.com',
    'blob:https://app.example.com/1',
  ])('refuses %s, opening nothing', async (url) => {
    const { links, opened } = setUp();
    await expect(links.open(url)).rejects.toThrow('Only web links can be opened');
    expect(opened).toEqual([]);
  });

  it('refuses what is not a link at all', async () => {
    const { links, opened } = setUp();
    await expect(links.open('not a link')).rejects.toThrow('not a link that can be opened');
    expect(opened).toEqual([]);
  });
});
