import { describe, expect, it } from 'vitest';
import {
  ExportError,
  MAX_DOWNLOAD_EXPORT_BYTES,
  type DestinationRequest,
  type ExportFilesPort,
} from '@dfai/application';
import { browserExportFiles, type ZipFiles } from './browser-export-files.ts';
import type { DownloadFile } from './browser-download.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

/** The port, with every download it hands over and every set of files it zipped. */
function setUp() {
  const downloads: DownloadFile[] = [];
  const zipped: Record<string, string>[] = [];
  const zip: ZipFiles = (files) => {
    zipped.push(
      Object.fromEntries(
        Object.entries(files).map(([path, data]) => [path, new TextDecoder().decode(data)]),
      ),
    );
    return bytes('PK');
  };
  let loads = 0;
  const port = browserExportFiles({
    download: (file) => {
      downloads.push(file);
      return Promise.resolve();
    },
    loadZip: () => {
      loads += 1;
      return Promise.resolve(zip);
    },
  });
  return { port, downloads, zipped, loads: () => loads };
}

/** A browser never cancels: it asks for no place. */
async function chosen(port: ExportFilesPort, request: DestinationRequest) {
  const destination = await port.choose(request);
  if (destination === null) throw new Error('a browser export was cancelled');
  return destination;
}

const oneFile = (companionSuffix: string | null = null): DestinationRequest => ({
  kind: 'file',
  suggestedName: 'Kickoff.md',
  extension: 'md',
  companionSuffix,
});

describe('a browser export (#774)', () => {
  it('downloads one note with no pictures as its own .md file, loading no zip', async () => {
    const { port, downloads, loads } = setUp();
    const destination = await chosen(port, oneFile());
    expect(destination).toMatchObject({ path: 'Kickoff.md', companion: null });
    await port.write({ destination, path: '', bytes: bytes('# Kickoff') });
    await port.finish(destination, { discard: false });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ name: 'Kickoff.md', type: 'text/markdown;charset=utf-8' });
    expect(new TextDecoder().decode(downloads[0]!.bytes)).toBe('# Kickoff');
    expect(loads()).toBe(0);
  });

  it('downloads a note with pictures as a .zip, its pictures in attachments/', async () => {
    const { port, downloads, zipped } = setUp();
    const destination = await chosen(port, oneFile(' attachments'));
    expect(destination).toMatchObject({ path: 'Kickoff.zip', companion: 'attachments' });
    await port.write({ destination, path: '', bytes: bytes('![](attachments/a.png)') });
    await port.write({ destination, path: 'attachments/a.png', bytes: bytes('png') });
    await port.finish(destination, { discard: false });
    expect(downloads.map(({ name, type }) => [name, type])).toEqual([
      ['Kickoff.zip', 'application/zip'],
    ]);
    expect(zipped).toEqual([
      { 'Kickoff.md': '![](attachments/a.png)', 'attachments/a.png': 'png' },
    ]);
  });

  it('downloads several notes as a .zip named for their folder, each at its own path', async () => {
    const { port, downloads, zipped } = setUp();
    const destination = await chosen(port, {
      kind: 'folder',
      folderName: 'Exported notes 2026-11-05',
    });
    expect(destination.path).toBe('Exported notes 2026-11-05.zip');
    await port.write({ destination, path: 'Alpha.md', bytes: bytes('a') });
    await port.write({ destination, path: 'Beta.md', bytes: bytes('b') });
    await port.finish(destination, { discard: false });
    expect(downloads.map((file) => file.name)).toEqual(['Exported notes 2026-11-05.zip']);
    expect(zipped).toEqual([{ 'Alpha.md': 'a', 'Beta.md': 'b' }]);
  });

  it('keeps a name that does not end in its extension whole', async () => {
    const { port } = setUp();
    const destination = await chosen(port, {
      kind: 'file',
      suggestedName: 'Notes',
      extension: 'md',
      companionSuffix: ' attachments',
    });
    expect(destination.path).toBe('Notes.zip');
  });

  it('downloads nothing for an export that is discarded', async () => {
    const { port, downloads } = setUp();
    const destination = await chosen(port, oneFile());
    await port.write({ destination, path: '', bytes: bytes('x') });
    await port.finish(destination, { discard: true });
    expect(downloads).toEqual([]);
  });

  it('keeps each destination apart, and lets none be written after it is finished', async () => {
    const { port, downloads } = setUp();
    const first = await chosen(port, oneFile());
    const second = await chosen(port, oneFile());
    expect(first.id).not.toBe(second.id);
    await port.write({ destination: first, path: '', bytes: bytes('one') });
    await port.write({ destination: second, path: '', bytes: bytes('two') });
    await port.finish(first, { discard: false });
    await expect(port.write({ destination: first, path: '', bytes: bytes('x') })).rejects.toThrow(
      'already finished',
    );
    await port.finish(second, { discard: false });
    expect(downloads.map((file) => new TextDecoder().decode(file.bytes))).toEqual(['one', 'two']);
  });

  it('refuses a file written twice', async () => {
    const { port } = setUp();
    const destination = await chosen(port, oneFile(' attachments'));
    await port.write({ destination, path: 'attachments/a.png', bytes: bytes('1') });
    await expect(
      port.write({ destination, path: 'attachments/a.png', bytes: bytes('2') }),
    ).rejects.toThrow('written twice');
  });

  it.each([
    '/etc/passwd',
    '../outside.md',
    'attachments/../../x.png',
    'a\\..\\b',
    './a.md',
    '\\server\\share.md',
    'C:\\Users\\x.md',
    'c:x.md',
    'attachments/a\u0000.png',
    'attachments/a\u001f.png',
    'a\u007f.md',
  ])('refuses a path that is not inside the export: %s', async (path) => {
    const { port } = setUp();
    const destination = await chosen(port, { kind: 'folder', folderName: 'Out' });
    await expect(port.write({ destination, path, bytes: bytes('x') })).rejects.toThrow(
      'not a path inside the export',
    );
  });

  it('refuses, before holding any more, an export larger than a download may be (#779)', async () => {
    const downloads: DownloadFile[] = [];
    const port = browserExportFiles({
      download: (file) => {
        downloads.push(file);
        return Promise.resolve();
      },
      loadZip: () => Promise.reject(new Error('never zipped')),
      maxBytes: 4,
    });
    const destination = await chosen(port, { kind: 'folder', folderName: 'Out' });
    await port.write({ destination, path: 'A.md', bytes: bytes('ab') });
    await port.write({ destination, path: 'B.md', bytes: bytes('cd') });
    const refused = port.write({ destination, path: 'C.md', bytes: bytes('e') });
    await expect(refused).rejects.toBeInstanceOf(ExportError);
    await expect(refused).rejects.toMatchObject({ kind: 'too-large' });
    await port.finish(destination, { discard: true });
    expect(downloads).toEqual([]);
  });

  it('holds a download to the web’s limit when none is given (#779)', async () => {
    const port = browserExportFiles({
      download: () => Promise.resolve(),
      loadZip: () => Promise.reject(new Error('never zipped')),
    });
    const destination = await chosen(port, { kind: 'folder', folderName: 'Out' });
    const over = { byteLength: MAX_DOWNLOAD_EXPORT_BYTES + 1 } as Uint8Array;
    await expect(port.write({ destination, path: 'A.md', bytes: over })).rejects.toMatchObject({
      kind: 'too-large',
    });
  });

  it('fails, downloading nothing, when a lone file was never written', async () => {
    const { port, downloads } = setUp();
    const destination = await chosen(port, oneFile());
    await expect(port.finish(destination, { discard: false })).rejects.toThrow(
      'did not write its one file',
    );
    expect(downloads).toEqual([]);
  });

  it('fails, downloading nothing, when the zip library cannot be loaded', async () => {
    const downloads: DownloadFile[] = [];
    const port = browserExportFiles({
      download: (file) => {
        downloads.push(file);
        return Promise.resolve();
      },
      loadZip: () => Promise.reject(new Error('chunk failed to load')),
    });
    const destination = await chosen(port, { kind: 'folder', folderName: 'Out' });
    await port.write({ destination, path: 'A.md', bytes: bytes('a') });
    await expect(port.finish(destination, { discard: false })).rejects.toThrow('chunk failed');
    expect(downloads).toEqual([]);
  });
});
