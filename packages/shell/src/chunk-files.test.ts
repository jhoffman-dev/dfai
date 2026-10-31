// @vitest-environment jsdom
import { chunkAddress, importAgain } from './chunk-files.ts';

function writeChunkMap(content: string) {
  const meta = document.createElement('meta');
  meta.name = 'atlas-chunks';
  meta.content = content;
  document.head.append(meta);
}

describe('importAgain', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('knows no file where the page has no chunk map, as under the development server', () => {
    expect(importAgain('graph-page')(2)).toBeNull();
  });

  it('knows no file for a chunk the map does not name', () => {
    writeChunkMap(JSON.stringify({ 'later-parts': 'assets/later-parts-abc.js' }));
    expect(importAgain('graph-page')(2)).toBeNull();
  });

  it('puts the mapped file under a new address for each attempt', () => {
    writeChunkMap(JSON.stringify({ 'graph-page': 'assets/graph-page-abc.js' }));
    const third = chunkAddress('graph-page', 3);
    expect(third).toBe(new URL('assets/graph-page-abc.js?attempt=3', document.baseURI).href);
    expect(chunkAddress('graph-page', 4)).not.toBe(third);
  });

  it('warns of a map it cannot read, and knows no file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeChunkMap('{not json');
    expect(importAgain('graph-page')(2)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
