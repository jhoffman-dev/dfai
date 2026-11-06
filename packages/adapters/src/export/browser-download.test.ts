// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserDownload } from './browser-download.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The page's blob URLs, made and let go, and each link clicked with what it said then. */
function watchedPage() {
  const made: Blob[] = [];
  const revoked: string[] = [];
  const clicked: { href: string; download: string; inPage: boolean }[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    made.push(blob as Blob);
    return `blob:dfai/${made.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => revoked.push(url));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download, inPage: this.isConnected });
  });
  return { made, revoked, clicked };
}

describe('a browser download (#774)', () => {
  it('clicks a link in the page that downloads the bytes under the name, then takes it away', async () => {
    vi.useFakeTimers();
    const { made, clicked } = watchedPage();
    await browserDownload()({
      name: 'Kickoff.md',
      type: 'text/markdown',
      bytes: new TextEncoder().encode('# Kickoff'),
    });
    expect(clicked).toEqual([{ href: 'blob:dfai/1', download: 'Kickoff.md', inPage: true }]);
    expect(made[0]!.type).toBe('text/markdown');
    expect(await made[0]!.text()).toBe('# Kickoff');
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('lets the blob go only after the click has had time to read it', async () => {
    vi.useFakeTimers();
    const { revoked } = watchedPage();
    await browserDownload()({ name: 'a.zip', type: 'application/zip', bytes: new Uint8Array([1]) });
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(revoked).toEqual(['blob:dfai/1']);
  });
});
