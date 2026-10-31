// @vitest-environment jsdom
import { createVaultPath } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { composeWeb } from './composition.ts';

/*
 * Attack on PR #689 (#656): the web stub's vault must keep what it accepts or
 * refuse it. A write that resolves but reads back as nothing is data that
 * looks saved and is not — an image pasted into a note, an artifact's saved
 * copy, a PDF's highlights file all go through writeBinaryFile.
 */

const vault = '/sample';
const path = createVaultPath('attachments/pasted.png');
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** Settles to the bytes read back, or to the refusal the write gave. */
async function writeThenRead(): Promise<{ refused: unknown } | { read: Uint8Array }> {
  const { fs } = composeWeb().vault;
  try {
    await fs.writeBinaryFile({ vault, path, bytes, offset: 0 });
  } catch (refused) {
    return { refused };
  }
  return { read: new Uint8Array(await fs.readBinaryFile(path)) };
}

describe('the web stub keeps the files it says it wrote (attack #689)', () => {
  it('reads back the bytes a binary write accepted, or refuses the write', async () => {
    const outcome = await writeThenRead();
    if ('refused' in outcome) return;
    expect([...outcome.read]).toEqual([...bytes]);
  });

  it('lists a file a binary write accepted among the vault’s files', async () => {
    const { fs } = composeWeb().vault;
    try {
      await fs.writeBinaryFile({ vault, path, bytes, offset: 0 });
    } catch {
      return; // Refused out loud: nothing claims to be saved.
    }
    const found = await fs.listFiles({ extension: 'png', skipDirectories: [], maxDepth: 10 });
    expect(found).toContain(path);
  });
});
