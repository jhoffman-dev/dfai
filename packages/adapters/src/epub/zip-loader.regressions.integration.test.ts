// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EpubUnreadableError } from '@dfai/application';
import { MOST_FILES, openArchive } from './zip-loader.ts';

/*
 * Regressions from the verification of PR #536 (#505, ADR-0045 §6): a zip
 * bomb made of its directory. Every file of the archive may say it is empty,
 * so no size the archive declares passes a cap; but each file listed costs
 * memory as the archive is opened. Measured on this Mac (Node 26, jsdom): a
 * 30 MB archive, under the Library's 32 MB cap, listing 600,000 empty files
 * that all share one local header, took 2.3 s and kept 2.3 GB of heap after
 * `openArchive` returned. No book has a hundred thousand files.
 */

/** A ZIP64 archive listing `count` empty files, each a 46-byte directory entry pointing at one shared local header. */
function directoryBomb(count: number): Uint8Array {
  const local = Buffer.alloc(31);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(1, 26);
  local.write('f', 30);
  const centrals: Buffer[] = [];
  for (let at = 0; at < count; at += 1) {
    const name = Buffer.from(`f${at}`, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    centrals.push(central, name);
  }
  const directory = Buffer.concat(centrals);
  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(45, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeBigUInt64LE(BigInt(count), 24);
  zip64End.writeBigUInt64LE(BigInt(count), 32);
  zip64End.writeBigUInt64LE(BigInt(directory.length), 40);
  zip64End.writeBigUInt64LE(BigInt(local.length), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(local.length + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return new Uint8Array(Buffer.concat([local, directory, zip64End, locator, end]));
}

describe('a zip bomb made of its directory', () => {
  it('is refused as unreadable when opened, when it lists more files than any book has', async () => {
    const bytes = directoryBomb(100_000);
    // Small on disk, every file empty: neither the Library's size cap nor a declared size stops it.
    expect(bytes.length).toBeLessThan(6 * 1024 * 1024);
    await expect(openArchive(bytes)).rejects.toBeInstanceOf(EpubUnreadableError);
  }, 60_000);

  it('opens an archive listing as many files as a book may, and refuses one more', async () => {
    const archive = await openArchive(directoryBomb(MOST_FILES));
    expect(archive.entries).toHaveLength(MOST_FILES);
    await expect(openArchive(directoryBomb(MOST_FILES + 1))).rejects.toThrow(
      new EpubUnreadableError(`it lists more than ${MOST_FILES} files`),
    );
  });
});
