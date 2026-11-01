import { createVaultPath as p } from '@dfai/domain';
import {
  EntryChangedError,
  HOST_CHANGED_ON_DISK,
  isChangedOnDiskRefusal,
  VaultAccessError,
} from '@dfai/application';
import { describe, expect, it } from 'vitest';
import { GitHubRefusedError } from './github-api.ts';
import { FakeGitHub, type Received } from './fake-github.test-support.ts';
import { vaultOver } from './github-vault.test-support.ts';

/**
 * #664: the GitHub vault against the API's stand-in. The host's contract runs
 * in github-vault-fs.contract.test.ts; these are GitHub's own: each write one
 * commit, bytes kept exactly, and every way a write is refused rather than
 * laid over someone else's.
 */

const SEED = {
  'Welcome.md': '# Welcome\n',
  'Projects/Larkspur.md': '# Larkspur\n',
};

function seeded(files: Record<string, string | Uint8Array> = SEED) {
  const github = new FakeGitHub({ files });
  return { github, ...vaultOver(github) };
}

const isCall = (method: string, ending: string) => (request: Received) =>
  request.method === method && request.path.split('?')[0]!.endsWith(ending);
const isRefUpdate = isCall('PATCH', '/git/refs/heads/main');
const writesSent = (github: FakeGitHub) =>
  github.received
    .filter(({ method }) => method !== 'GET')
    .map(({ method, path }) => `${method} ${path}`);

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('the GitHub vault: round trips, one commit each', () => {
  it('saves a note as one commit on the branch, and reads it back', async () => {
    const { github, fs, vault } = seeded();
    const { modified } = await fs.readTextFile(p('Welcome.md'));
    const after = await fs.writeTextFile({
      vault,
      path: p('Welcome.md'),
      contents: '# Welcome back\n',
      expectedModified: modified,
    });
    expect(await github.textAt('Welcome.md')).toBe('# Welcome back\n');
    expect(await github.history()).toEqual(['Save Welcome.md', 'Seed']);
    expect(await fs.readTextFile(p('Welcome.md'))).toEqual({
      text: '# Welcome back\n',
      modified: after,
    });
    expect(after).not.toBe(modified);
  });

  it('creates, moves and trashes, each one commit, and the tree is as asked', async () => {
    const { github, fs, vault } = seeded();
    await fs.createNote({ vault, path: p('Ideas.md'), contents: 'idea' });
    await fs.moveEntry({ vault, from: p('Projects'), to: p('Areas') });
    await fs.trashEntry({ vault, path: p('Welcome.md') });
    expect(await github.paths()).toEqual(['Areas/Larkspur.md', 'Ideas.md']);
    expect(await github.history()).toEqual([
      'Trash Welcome.md',
      'Move Projects to Areas',
      'Create Ideas.md',
      'Seed',
    ]);
  });

  it('makes a folder git can hold, lists it empty, and moves and trashes it whole', async () => {
    const { github, fs, vault } = seeded();
    await fs.createFolder({ vault, path: p('Archive') });
    expect(await github.paths()).toContain('Archive/.gitkeep');
    expect(await fs.listDirectory(p('Archive'))).toEqual([]);
    expect((await fs.listDirectory(p(''))).map((entry) => entry.name)).toContain('Archive');
    await fs.moveEntry({ vault, from: p('Archive'), to: p('Old') });
    expect(await github.paths()).toContain('Old/.gitkeep');
    await fs.trashEntry({ vault, path: p('Old') });
    expect((await github.paths()).filter((path) => path.startsWith('Old'))).toEqual([]);
  });

  it('lists a note’s size and version as the read gives them', async () => {
    const { fs } = seeded();
    const [note] = await fs.listNotes({ skipDirectories: ['Projects'], maxDepth: 5 });
    const read = await fs.readTextFile(p('Welcome.md'));
    expect(note).toEqual({
      name: 'Welcome.md',
      path: 'Welcome.md',
      modified: read.modified,
      size: 10,
    });
  });

  it('sends nothing for a write meant for another vault', async () => {
    const { github, fs } = seeded();
    const before = github.received.length;
    await expect(
      fs.createNote({ vault: 'github:other/repo#main', path: p('x.md'), contents: 'x' }),
    ).rejects.toThrow('not the open vault');
    expect(github.received.length).toBe(before);
  });

  it('runs two saves at once one after the other, so neither refuses the other', async () => {
    const { github, fs, vault } = seeded();
    const [welcome, larkspur] = await Promise.all([
      fs.readTextFile(p('Welcome.md')),
      fs.readTextFile(p('Projects/Larkspur.md')),
    ]);
    await Promise.all([
      fs.writeTextFile({
        vault,
        path: p('Welcome.md'),
        contents: 'a',
        expectedModified: welcome.modified,
      }),
      fs.writeTextFile({
        vault,
        path: p('Projects/Larkspur.md'),
        contents: 'b',
        expectedModified: larkspur.modified,
      }),
    ]);
    expect([
      await github.textAt('Welcome.md'),
      await github.textAt('Projects/Larkspur.md'),
    ]).toEqual(['a', 'b']);
  });

  it('refuses a name differing only in case itself, though GitHub’s tree would take it', async () => {
    const { github, fs, vault } = seeded();
    await expect(fs.createNote({ vault, path: p('WELCOME.md'), contents: 'x' })).rejects.toThrow(
      'already exists',
    );
    await expect(fs.moveEntry({ vault, from: p('Welcome.md'), to: p('projects') })).rejects.toThrow(
      'already there',
    );
    expect(writesSent(github)).toEqual([]);
  });
});

describe('the GitHub vault keeps bytes exactly (ADR-0003)', () => {
  const ODD = '﻿# Odd\r\nCRLF line\r\nno last newline';
  const ODD_BYTES = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(ODD.slice(1))]);

  it('reads a byte-order mark, CRLF and a missing last newline as they are', async () => {
    const { fs } = seeded({ 'Odd.md': ODD_BYTES });
    expect((await fs.readTextFile(p('Odd.md'))).text).toBe(ODD);
    expect((await fs.readNotes(['Odd.md']))[0]!.text).toBe(ODD);
  });

  it('commits nothing for a save of the bytes already there', async () => {
    const { github, fs, vault } = seeded({ 'Odd.md': ODD_BYTES });
    const read = await fs.readTextFile(p('Odd.md'));
    const head = await github.headSha();
    const answered = await fs.writeTextFile({
      vault,
      path: p('Odd.md'),
      contents: read.text,
      expectedModified: read.modified,
      expectedText: read.text,
    });
    expect(answered).toBe(read.modified);
    expect(await github.headSha()).toBe(head);
    expect(writesSent(github)).toEqual([]);
  });

  it('writes an edit as exactly its bytes, mark and line endings kept', async () => {
    const { github, fs, vault } = seeded({ 'Odd.md': ODD_BYTES });
    const read = await fs.readTextFile(p('Odd.md'));
    const edited = `${read.text}\r\nand one more\n\n`;
    await fs.writeTextFile({
      vault,
      path: p('Odd.md'),
      contents: edited,
      expectedModified: read.modified,
    });
    const stored = await github.bytesAt('Odd.md');
    expect([...stored!.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(stored)).toBe(edited);
  });

  it('moves a note without reading or uploading it: the same blob lands', async () => {
    const { github, fs, vault } = seeded({ 'Odd.md': ODD_BYTES });
    await fs.moveEntry({ vault, from: p('Odd.md'), to: p('Even.md') });
    expect([...(await github.bytesAt('Even.md'))!]).toEqual([...ODD_BYTES]);
    expect(writesSent(github).some((call) => call.endsWith('/git/blobs'))).toBe(false);
  });

  it('keeps bytes written in chunks, and a file that is not UTF-8 stays bytes', async () => {
    const { github, fs, vault } = seeded();
    const path = p('pasted.png');
    await fs.writeBinaryFile({ vault, path, bytes: new Uint8Array([0x89, 0x50]), offset: 0 });
    await fs.writeBinaryFile({ vault, path, bytes: new Uint8Array([0xff]), offset: 2 });
    expect([...(await github.bytesAt('pasted.png'))!]).toEqual([0x89, 0x50, 0xff]);
    await expect(fs.readTextFile(path)).rejects.toThrow('not a text file');
    expect(await fs.readNotes(['pasted.png', 'Welcome.md'])).toHaveLength(1);
    await fs.writeBinaryFile({ vault, path, bytes: new Uint8Array([1]), offset: 0, replace: true });
    expect([...(await github.bytesAt('pasted.png'))!]).toEqual([1]);
  });
});

describe('the GitHub vault refuses a write over anything that moved', () => {
  it('refuses a save whose blob moved, by its version, with the host’s changed-on-disk refusal', async () => {
    const { github, fs, vault } = seeded();
    const read = await fs.readTextFile(p('Welcome.md'));
    await github.commitOutside({ 'Welcome.md': '# From the Mac\n' });
    const error = await refusal(
      fs.writeTextFile({
        vault,
        path: p('Welcome.md'),
        contents: 'mine',
        expectedModified: read.modified,
      }),
    );
    expect(isChangedOnDiskRefusal(error)).toBe(true);
    expect(await github.textAt('Welcome.md')).toBe('# From the Mac\n');
    expect(writesSent(github)).toEqual([]);
  });

  it('refuses a save whose blob moved, by its text, when no version was given', async () => {
    const { github, fs, vault } = seeded();
    const read = await fs.readTextFile(p('Welcome.md'));
    await github.commitOutside({ 'Welcome.md': '# From the Mac\n' });
    const error = await refusal(
      fs.writeTextFile({
        vault,
        path: p('Welcome.md'),
        contents: 'mine',
        expectedModified: null,
        expectedText: read.text,
      }),
    );
    expect(error.message).toBe(HOST_CHANGED_ON_DISK);
    expect(await github.textAt('Welcome.md')).toBe('# From the Mac\n');
  });

  it('refuses a save when the branch head moves between its check and its commit, and never forces', async () => {
    const { github, fs, vault } = seeded();
    const read = await fs.readTextFile(p('Welcome.md'));
    github.intercept(isCall('POST', '/git/commits'), async (request) => {
      await github.commitOutside({ 'Other.md': 'from the Mac' });
      return github.respond(request);
    });
    const error = await refusal(
      fs.writeTextFile({
        vault,
        path: p('Welcome.md'),
        contents: 'mine',
        expectedModified: read.modified,
      }),
    );
    expect(isChangedOnDiskRefusal(error)).toBe(true);
    expect(await github.textAt('Welcome.md')).toBe('# Welcome\n');
    expect(await github.textAt('Other.md')).toBe('from the Mac');
    const updates = github.received.filter(isRefUpdate);
    expect(updates.map(({ body }) => body)).toEqual([{ sha: expect.any(String), force: false }]);
  });

  for (const status of [422, 409]) {
    it(`refuses a save whose ref update GitHub answers ${status}, once, without forcing it`, async () => {
      const { github, fs, vault } = seeded();
      const read = await fs.readTextFile(p('Welcome.md'));
      github.intercept(
        isRefUpdate,
        () => new Response(JSON.stringify({ message: 'Update is not a fast forward' }), { status }),
      );
      const error = await refusal(
        fs.writeTextFile({
          vault,
          path: p('Welcome.md'),
          contents: 'mine',
          expectedModified: read.modified,
        }),
      );
      expect(error.message).toBe(HOST_CHANGED_ON_DISK);
      expect(github.received.filter(isRefUpdate)).toHaveLength(1);
      expect(await github.textAt('Welcome.md')).toBe('# Welcome\n');
    });
  }

  it('refuses a create when the head moves under it, and nothing is created', async () => {
    const { github, fs, vault } = seeded();
    github.intercept(isCall('POST', '/git/commits'), async (request) => {
      await github.commitOutside({ 'Other.md': 'x' });
      return github.respond(request);
    });
    const error = await refusal(fs.createNote({ vault, path: p('Ideas.md'), contents: 'idea' }));
    expect(isChangedOnDiskRefusal(error)).toBe(true);
    expect(await github.paths()).not.toContain('Ideas.md');
  });

  it('refuses a trash of a file changed since it was read, and one whose head moved under it', async () => {
    const { github, fs, vault } = seeded();
    const read = await fs.readTextFile(p('Welcome.md'));
    const unchanged = [{ path: p('Welcome.md'), modified: read.modified, text: read.text }];
    await github.commitOutside({ 'Welcome.md': 'edited elsewhere' });
    await expect(fs.trashEntry({ vault, path: p('Welcome.md'), unchanged })).rejects.toThrow(
      EntryChangedError,
    );
    github.intercept(isCall('POST', '/git/commits'), async (request) => {
      await github.commitOutside({ 'Other.md': 'x' });
      return github.respond(request);
    });
    await expect(fs.trashEntry({ vault, path: p('Projects') })).rejects.toThrow(EntryChangedError);
    expect(await github.paths()).toEqual(['Other.md', 'Projects/Larkspur.md', 'Welcome.md']);
  });

  it('refuses a trash of a file whose version matches but whose text does not', async () => {
    const { github, fs, vault } = seeded();
    const read = await fs.readTextFile(p('Welcome.md'));
    const unchanged = [
      { path: p('Welcome.md'), modified: read.modified, text: 'not what was read' },
    ];
    await expect(fs.trashEntry({ vault, path: p('Welcome.md'), unchanged })).rejects.toThrow(
      EntryChangedError,
    );
    expect(await github.paths()).toContain('Welcome.md');
  });

  it('takes another refusal of a commit as GitHub’s, not as a note changed on disk', async () => {
    const { github, fs, vault } = seeded();
    github.intercept(
      isCall('POST', '/git/trees'),
      () => new Response(JSON.stringify({ message: 'Invalid tree info' }), { status: 422 }),
    );
    const error = await refusal(fs.createNote({ vault, path: p('Ideas.md'), contents: 'x' }));
    expect(error).toBeInstanceOf(GitHubRefusedError);
    expect(isChangedOnDiskRefusal(error)).toBe(false);
    expect(github.received.filter(isRefUpdate)).toEqual([]);
  });

  it('commits nothing on a blob GitHub names otherwise than the bytes sent', async () => {
    const { github, fs, vault } = seeded();
    github.intercept(
      isCall('POST', '/git/blobs'),
      () => new Response(JSON.stringify({ sha: 'a'.repeat(40) }), { status: 201 }),
    );
    await expect(fs.createNote({ vault, path: p('Ideas.md'), contents: 'x' })).rejects.toThrow(
      'other bytes',
    );
    expect(writesSent(github).filter((call) => !call.endsWith('/git/blobs'))).toEqual([]);
  });
});

describe('the GitHub vault refuses an answer it cannot trust', () => {
  it('refuses a blob whose bytes are not the blob named', async () => {
    const { github, fs } = seeded();
    github.intercept(
      (request) => request.path.includes('/git/blobs/'),
      () => new Response(JSON.stringify({ content: btoa('# Tampered\n'), encoding: 'base64' })),
    );
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toThrow('cannot read');
  });

  it('refuses a blob that is not base64, or not sent as base64', async () => {
    const { github, fs } = seeded();
    const blob = (request: Received) => request.path.includes('/git/blobs/');
    github.intercept(
      blob,
      () => new Response(JSON.stringify({ content: '!!', encoding: 'base64' })),
    );
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toThrow('cannot read');
    github.intercept(
      blob,
      () => new Response(JSON.stringify({ content: '# Welcome\n', encoding: 'utf-8' })),
    );
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toThrow('cannot read');
  });

  it('refuses a tree with an entry it cannot read, or one GitHub cut short', async () => {
    const { github, fs } = seeded();
    const tree = (request: Received) => request.path.includes('/git/trees/');
    const listing = (body: unknown) => () => new Response(JSON.stringify(body));
    const sha = 'b'.repeat(40);
    github.intercept(
      tree,
      listing({
        sha,
        truncated: false,
        tree: [{ path: 'a.md', mode: '100644', type: 'blob', sha }],
      }),
    );
    await expect(fs.listNotes({ skipDirectories: [], maxDepth: 5 })).rejects.toThrow('cannot read');
    github.intercept(tree, listing({ sha, truncated: true, tree: [] }));
    await expect(fs.listNotes({ skipDirectories: [], maxDepth: 5 })).rejects.toThrow('more files');
  });

  it('refuses a branch head that is not a commit’s name, and says when the branch is not there', async () => {
    const { github, fs } = seeded();
    const ref = isCall('GET', '/git/ref/heads/main');
    github.intercept(ref, () => new Response(JSON.stringify({ object: { sha: 'HEAD' } })));
    await expect(fs.listDirectory(p(''))).rejects.toThrow('cannot read');
    github.intercept(
      ref,
      () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
    );
    await expect(fs.listDirectory(p(''))).rejects.toThrow('branch is not on GitHub');
  });

  it('passes on any other refusal of the head as GitHub’s', async () => {
    const { github, fs } = seeded();
    github.intercept(
      isCall('GET', '/git/ref/heads/main'),
      () => new Response('{}', { status: 500 }),
    );
    await expect(fs.listDirectory(p(''))).rejects.toThrow(GitHubRefusedError);
  });

  it('reads a folder once, then again only when the head moved', async () => {
    const { github, fs } = seeded();
    await fs.listDirectory(p(''));
    await fs.listDirectory(p('Projects'));
    const trees = () =>
      github.received.filter((request) => request.path.includes('/git/trees/')).length;
    expect(trees()).toBe(1);
    await github.commitOutside({ 'New.md': 'x' });
    expect((await fs.listDirectory(p(''))).map((entry) => entry.name)).toContain('New.md');
    expect(trees()).toBe(2);
  });

  it('refuses reads of git’s own folder before asking GitHub anything', async () => {
    const { github, fs } = seeded();
    await expect(fs.readBinaryFile(p('.git/config'))).rejects.toThrow(VaultAccessError);
    expect(github.received).toEqual([]);
  });
});
