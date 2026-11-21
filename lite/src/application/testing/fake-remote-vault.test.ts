import { RemoteAuthError, RemoteMovedError } from '../ports/index.ts';
import { FakeRemoteVault, fakeSha } from './index.ts';

describe('the fake remote vault', () => {
  it('serves the tree and blobs of its head, content-addressed', async () => {
    const remote = new FakeRemoteVault({ 'A.md': 'one', 'B.md': 'one' });
    const head = await remote.head();
    const tree = await remote.tree(head.treeSha);
    expect(tree).toEqual([
      { path: 'A.md', sha: fakeSha('blob', 'one') },
      { path: 'B.md', sha: fakeSha('blob', 'one') },
    ]);
    expect(await remote.blobs([fakeSha('blob', 'one')])).toEqual(
      new Map([[fakeSha('blob', 'one'), 'one']]),
    );
  });

  it('pushes on its head and refuses a push on a moved branch', async () => {
    const remote = new FakeRemoteVault({ 'A.md': 'one' });
    const head = await remote.head();
    remote.pushFromElsewhere({ upserts: { 'C.md': 'three' } });
    const stale = { message: 'm', upserts: [], deletes: ['A.md'], parentCommitSha: head.commitSha };
    await expect(remote.push(stale)).rejects.toBeInstanceOf(RemoteMovedError);
    const moved = await remote.head();
    await remote.push({ ...stale, parentCommitSha: moved.commitSha });
    expect(remote.files()).toEqual({ 'C.md': 'three' });
  });

  it('fails the next call once when told to', async () => {
    const remote = new FakeRemoteVault();
    remote.failNext(new RemoteAuthError());
    await expect(remote.head()).rejects.toBeInstanceOf(RemoteAuthError);
    await expect(remote.head()).resolves.toMatchObject({ commitSha: expect.any(String) });
  });
});
