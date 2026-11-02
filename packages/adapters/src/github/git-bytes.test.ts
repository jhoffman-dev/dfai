import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  gitBlobSha,
  textOfBytes,
  utf8,
  versionOfBlob,
} from './git-bytes.ts';

/** #664: what `git hash-object` answers, so the vault names blobs exactly as GitHub does. */
describe('bytes as git names and GitHub carries them', () => {
  it('names a blob as git does', async () => {
    expect(await gitBlobSha(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await gitBlobSha(utf8('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('carries every byte value through base64 both ways, GitHub’s line breaks and all', () => {
    const every = Uint8Array.from({ length: 256 }, (_, index) => index);
    const big = new Uint8Array(100_000).fill(0xab);
    expect([...base64ToBytes(bytesToBase64(every))!]).toEqual([...every]);
    expect(base64ToBytes(bytesToBase64(big).replace(/(.{60})/g, '$1\n'))).toEqual(big);
    expect(base64ToBytes('not base64!')).toBeNull();
  });

  it('keeps a byte-order mark as text, and refuses bytes that are not UTF-8', () => {
    expect(textOfBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a');
    expect(textOfBytes(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });

  it('gives a version that is a safe integer and differs with the blob', () => {
    const version = versionOfBlob('ffffffffffffffffffffffffffffffffffffffff');
    expect(Number.isSafeInteger(version)).toBe(true);
    expect(versionOfBlob('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')).not.toBe(
      versionOfBlob('ce013625030ba8dba906f756967f9e9ca394464a'),
    );
  });
});
