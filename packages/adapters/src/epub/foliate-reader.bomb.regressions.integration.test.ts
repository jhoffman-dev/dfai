// @vitest-environment jsdom
import { createDeflateRaw, crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EpubUnreadableError } from '@dfai/application';
import { fixtureEpub, HARE_AND_TORTOISE } from '../../../../tools/epub/fixture-epub.ts';
import { foliateEpubReader } from './foliate-reader.ts';
import { bombReason, MOST_BOOK_BYTES, MOST_FILE_BYTES } from './zip-loader.ts';

/*
 * Regressions from the attack on PR #536 (#505): a zip bomb. An EPUB is a ZIP, and a chapter of a
 * megabyte on disk can say, truthfully, that it inflates to a gigabyte. The
 * reader inflates a chapter whole (`loadText`), parses it with DOMParser and
 * copies it again into the frame's node list, all in the app's own web
 * process: nothing reads the sizes the archive declares before that. The
 * book must be refused, said as unreadable, before anything is inflated.
 */

const CHAPTER = 'OEBPS/hare.xhtml';
/** How far the bombed chapter inflates: 1 GiB of spaces, about a megabyte deflated. */
const INFLATED = 2 ** 30;

/** The stored entries of a ZIP `storedZip` wrote, by name. */
function storedEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    entries.set(name, zip.subarray(at + 30 + nameLength, at + 30 + nameLength + size));
    at += 30 + nameLength + size;
  }
  return entries;
}

/** `head`, then `count` spaces, then `tail`, deflated as a ZIP entry's data is; with its CRC and size. */
async function deflatedFiller({
  head,
  count,
  tail,
}: {
  head: string;
  count: number;
  tail: string;
}) {
  const deflate = createDeflateRaw({ level: 1 });
  const out: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => out.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  const write = (chunk: Buffer) =>
    new Promise<void>((resolve) => {
      if (deflate.write(chunk)) resolve();
      else deflate.once('drain', resolve);
    });
  const first = Buffer.from(head, 'utf8');
  const last = Buffer.from(tail, 'utf8');
  const block = Buffer.alloc(16 * 1024 * 1024, 0x20);
  let crc = crc32(first);
  await write(first);
  for (let left = count; left > 0; left -= block.length) {
    const piece = left >= block.length ? block : block.subarray(0, left);
    crc = crc32(piece, crc);
    await write(piece);
  }
  crc = crc32(last, crc);
  await write(last);
  deflate.end();
  await done;
  return { data: Buffer.concat(out), crc, size: first.length + count + last.length };
}

interface Entry {
  readonly name: string;
  readonly data: Buffer;
  readonly crc: number;
  readonly size: number;
  readonly method: 0 | 8;
}

/** A ZIP of `entries`, each stored or deflated as it says. */
function zipOf(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(entry.crc >>> 0, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.crc >>> 0, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The fables' book, its one chapter swapped for one deflated with `count` spaces in it, saying it is `says` bytes. */
async function bombedEpub(count: number, says?: number): Promise<Buffer> {
  const book = storedEntries(fixtureEpub({ chapters: [HARE_AND_TORTOISE] }));
  const original = book.get(CHAPTER)?.toString('utf8') ?? '';
  const split = original.indexOf('</body>');
  const filler = await deflatedFiller({
    head: `${original.slice(0, split)}<p>`,
    count,
    tail: `</p>${original.slice(split)}`,
  });
  return zipOf(
    [...book].map(([name, data]) =>
      name === CHAPTER
        ? { name, ...filler, size: says ?? filler.size, method: 8 }
        : { name, data, crc: crc32(data), size: data.length, method: 0 },
    ),
  );
}

describe('a zip bomb', () => {
  it('is refused as unreadable when opened, before its gigabyte chapter is inflated', async () => {
    const bytes = await bombedEpub(INFLATED);
    // The bomb is small on disk: no size check on the file picked stops it.
    expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
    await expect(foliateEpubReader().open(new Uint8Array(bytes))).rejects.toBeInstanceOf(
      EpubUnreadableError,
    );
  }, 60_000);

  it('is told apart from a book of the same make whose chapter inflates as a real one does', async () => {
    const book = await foliateEpubReader().open(new Uint8Array(await bombedEpub(4096)));
    expect(await book.sectionText(0)).toContain('A Hare one day ridiculed');
    book.close();
  });
});

describe('a zip bomb whose sizes lie', () => {
  it('is refused as unreadable the moment its chapter inflates past the size it says', async () => {
    // It says 4 KB, too small to be judged a bomb by its sizes; it inflates to 8 MB.
    const book = await foliateEpubReader().open(
      new Uint8Array(await bombedEpub(8 * 1024 * 1024, 4096)),
    );
    await expect(book.sectionText(0)).rejects.toBeInstanceOf(EpubUnreadableError);
    book.close();
  });
});

describe('what an archive says of its sizes', () => {
  const file = (uncompressedSize: number, compressedSize = uncompressedSize) => ({
    filename: 'OEBPS/hare.xhtml',
    compressedSize,
    uncompressedSize,
  });
  const MB = 1024 * 1024;

  it('is a bomb for one file past the most a file may inflate to, however it deflates', () => {
    expect(bombReason([file(MOST_FILE_BYTES)])).toBeNull();
    expect(bombReason([file(MOST_FILE_BYTES + 1)])).toMatch(/inflates past 64 MB/);
  });

  it('is a bomb for files that together pass the most a book may inflate to', () => {
    const files = Array.from({ length: MOST_BOOK_BYTES / MOST_FILE_BYTES }, () =>
      file(MOST_FILE_BYTES),
    );
    expect(bombReason(files)).toBeNull();
    expect(bombReason([...files, file(1)])).toMatch(/inflates past 512 MB/);
  });

  it('is a bomb for a file of more than a megabyte that inflates more than a hundred times over', () => {
    expect(bombReason([file(2 * MB, (2 * MB) / 100)])).toBeNull();
    expect(bombReason([file(2 * MB, (2 * MB) / 100 - 1)])).toMatch(/more than 100 times/);
    // A small file deflates as well as it likes: a page of spaces is no bomb.
    expect(bombReason([file(MB, 1)])).toBeNull();
  });
});
