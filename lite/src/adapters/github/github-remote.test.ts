import {
  RemoteAuthError,
  RemoteMovedError,
  RemoteUnreachableError,
  type RemoteVault,
} from '../../application/index.ts';
import { FAKE_REPO, FAKE_TOKEN, FakeGitHub } from './fake-github.test-support.ts';
import { gitBlobShaOfText } from './git-bytes.ts';
import { createGitHubRemote, type GitHubRemoteOptions } from './index.ts';

const PLAN = 'Projects/Larkspur Payroll.md';
const CAFE = 'Café/Résumé — Mara Quill.md';

function remoteOver(github: FakeGitHub, extra: Partial<GitHubRemoteOptions> = {}): RemoteVault {
  return createGitHubRemote({
    ...FAKE_REPO,
    token: FAKE_TOKEN,
    fetch: github.fetch,
    // Never fires unless a test says so: no request is given up on real time.
    timeout: () => new Promise(() => {}),
    wait: async () => {},
    ...extra,
  });
}

async function headOf(remote: RemoteVault) {
  const head = await remote.head();
  if (head === null) throw new Error('expected a head');
  return head;
}

describe('the GitHub remote', () => {
  it('reads the tree and blobs, and pushes one commit that reads back', async () => {
    const github = new FakeGitHub({ [PLAN]: 'Rollout plan.', 'Inbox/Old.md': 'old' });
    const remote = remoteOver(github);
    const head = await headOf(remote);
    const tree = await remote.tree(head.treeSha);
    expect(tree.map(({ path }) => path)).toEqual(['Inbox/Old.md', PLAN]);
    const texts = await remote.blobs(tree.map(({ sha }) => sha));
    expect([...texts.values()]).toEqual(['old', 'Rollout plan.']);

    const pushed = await remote.push({
      message: 'Notes: 2 changed',
      upserts: [{ path: PLAN, text: 'Rollout plan, v2.' }],
      deletes: ['Inbox/Old.md'],
      parentCommitSha: head.commitSha,
    });
    expect(github.files()).toEqual({ [PLAN]: 'Rollout plan, v2.' });
    expect(github.history()).toEqual(['Notes: 2 changed', 'Seed']);
    expect(await remote.head()).toEqual(pushed);
    expect(await remote.tree(pushed.treeSha)).toEqual([
      { path: PLAN, sha: await gitBlobShaOfText('Rollout plan, v2.') },
    ]);
    const update = github.received.find(({ method }) => method === 'PATCH');
    expect(update?.body).toMatchObject({ force: false });
  });

  it('keeps non-ASCII paths and content byte for byte', async () => {
    const text = '﻿Naïve résumé — 日本語 🌱\r\nline two';
    const github = new FakeGitHub({});
    const remote = remoteOver(github);
    const head = await headOf(remote);
    const pushed = await remote.push({
      message: 'Notes: Résumé',
      upserts: [{ path: CAFE, text }],
      deletes: [],
      parentCommitSha: head.commitSha,
    });
    expect(github.files()[CAFE]).toBe(text);
    const [entry] = await remote.tree(pushed.treeSha);
    expect(entry).toEqual({ path: CAFE, sha: await gitBlobShaOfText(text) });
    expect(await remote.blobs([entry?.sha as string])).toEqual(
      new Map([[entry?.sha as string, text]]),
    );
  });

  it('refuses a push on a branch that moved, and does not force it', async () => {
    const github = new FakeGitHub({ [PLAN]: 'one' });
    const remote = remoteOver(github);
    const head = await headOf(remote);
    await github.commitOutside({ [PLAN]: 'two, from elsewhere' });
    await expect(
      remote.push({
        message: 'm',
        upserts: [{ path: PLAN, text: 'three' }],
        deletes: [],
        parentCommitSha: head.commitSha,
      }),
    ).rejects.toBeInstanceOf(RemoteMovedError);
    expect(github.files()).toEqual({ [PLAN]: 'two, from elsewhere' });
  });

  it('says a refused token as an auth error that never holds the token', async () => {
    const github = new FakeGitHub({ [PLAN]: 'one' });
    const remote = remoteOver(github, { token: 'github_pat_wrong-secret' });
    const error = await remote.head().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteAuthError);
    expect(String((error as Error).message)).not.toContain('wrong-secret');
  });

  it('says a repository the token cannot see as an auth error', async () => {
    const github = new FakeGitHub({ [PLAN]: 'one' });
    const remote = createGitHubRemote({
      ...FAKE_REPO,
      repo: 'not-shared',
      token: FAKE_TOKEN,
      fetch: github.fetch,
    });
    await expect(remote.head()).rejects.toBeInstanceOf(RemoteAuthError);
  });

  it('gives up a request that hangs, as unreachable', async () => {
    const github = new FakeGitHub({ [PLAN]: 'one' });
    const hung = github.hang(({ path }) => path.includes('/git/ref/'));
    const remote = remoteOver(github, { timeout: () => hung });
    const error = await remote.head().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteUnreachableError);
    expect((error as Error).message).toMatch(/in time/);
  });

  it('says a network failure as unreachable', async () => {
    const remote = remoteOver(new FakeGitHub({}), {
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(remote.head()).rejects.toBeInstanceOf(RemoteUnreachableError);
  });

  it('waits out a short rate limit, then answers', async () => {
    const github = new FakeGitHub({ [PLAN]: 'one' });
    github.intercept(
      ({ path }) => path.includes('/git/ref/'),
      () => new Response('{}', { status: 403, headers: { 'retry-after': '2' } }),
    );
    const waited: number[] = [];
    const remote = remoteOver(github, { wait: async (ms) => void waited.push(ms) });
    expect(await remote.head()).not.toBeNull();
    expect(waited).toEqual([2000]);
  });

  it('says a secondary rate limit as try-later, not as a refused token', async () => {
    const github = new FakeGitHub({ [PLAN]: 'one' });
    github.intercept(
      ({ path }) => path.includes('/git/ref/'),
      () =>
        new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), {
          status: 403,
        }),
    );
    await expect(remoteOver(github).head()).rejects.toBeInstanceOf(RemoteUnreachableError);
  });

  it('refuses a truncated tree rather than treat it as complete', async () => {
    const github = new FakeGitHub({ [PLAN]: 'one', 'Inbox/Two.md': 'two' });
    const remote = remoteOver(github);
    const head = await headOf(remote);
    github.truncateTrees = true;
    await expect(remote.tree(head.treeSha)).rejects.toThrow(/more files/);
  });

  it('refuses a blob whose bytes are not the blob asked for', async () => {
    const github = new FakeGitHub({ [PLAN]: 'one' });
    const remote = remoteOver(github);
    const [entry] = await remote.tree((await headOf(remote)).treeSha);
    github.intercept(
      ({ path }) => path.includes('/git/blobs/'),
      () => new Response(JSON.stringify({ content: btoa('other'), encoding: 'base64' })),
    );
    await expect(remote.blobs([entry?.sha as string])).rejects.toThrow(/cannot read/);
  });

  it('starts an empty repository: no head, and the first push creates the branch', async () => {
    const github = new FakeGitHub(null);
    const remote = remoteOver(github);
    expect(await remote.head()).toBeNull();
    const pushed = await remote.push({
      message: 'Notes: 2 changed',
      upserts: [
        { path: PLAN, text: 'one' },
        { path: CAFE, text: 'deux' },
      ],
      deletes: [],
      parentCommitSha: null,
    });
    expect(github.files()).toEqual({ [PLAN]: 'one', [CAFE]: 'deux' });
    expect(await remote.head()).toEqual(pushed);
    expect((await remote.tree(pushed.treeSha)).map(({ path }) => path)).toEqual([CAFE, PLAN]);
  });

  it('refuses a first push when someone else started the repository meanwhile', async () => {
    const github = new FakeGitHub(null);
    const remote = remoteOver(github);
    expect(await remote.head()).toBeNull();
    await github.commitOutside({ 'README.md': 'hello' });
    await expect(
      remote.push({
        message: 'm',
        upserts: [{ path: PLAN, text: 'one' }],
        deletes: [],
        parentCommitSha: null,
      }),
    ).rejects.toBeInstanceOf(RemoteMovedError);
    expect(github.files()).toEqual({ 'README.md': 'hello' });
  });
});
