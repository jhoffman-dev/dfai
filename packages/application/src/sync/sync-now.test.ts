import { describe, expect, it } from 'vitest';
import { recordingActivity } from '../testing/fake-activity.ts';
import {
  fakeBlob,
  failed,
  memoryVault,
  memorySyncFiles,
  OK,
  said,
  scriptedGit,
  statusText,
  type GitScript,
} from '../testing/fake-git.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';
import { ProgramMissingError } from './ports.ts';
import { SyncError } from './git-steps.ts';
import { syncNow } from './sync-now.ts';

const clock = { now: () => 1_000, localNow: () => '2026-09-28T14:05:00' };
const MARKERS = /^(<<<<<<<|=======|>>>>>>>)/m;
/** What a merge leaves in a text file both sides changed. */
const MARKED = '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\n';

function setUp({
  script = {},
  files = {},
  sides = {},
  syncFiles = {},
}: {
  script?: GitScript;
  files?: Record<string, string>;
  sides?: Record<string, { ours: string; theirs: string }>;
  syncFiles?: Partial<Record<'journal.json' | 'exclude', string>>;
} = {}) {
  const vault = memoryVault(files);
  const { git, calls, called } = scriptedGit({ script, vault: vault.files, sides });
  const { port: files_ } = memorySyncFiles(syncFiles);
  const activity = recordingActivity();
  const flushed: string[] = [];
  const unsaved = {
    flushAll: async () => {
      flushed.push(`flushed before ${calls.length} git calls`);
    },
  };
  const run = () =>
    syncNow({
      ports: { git, fs: vault.fs, markdown: fakeMarkdown(), files: files_, unsaved, activity },
      mac: 'Studio',
      clock,
    });
  return { run, calls, called, activity, files: vault.files, flushed };
}

/**
 * A run with no conflicts anywhere: one status per step of `syncNow` — the
 * files it left out, the leftover-merge check, case renames, what is staged,
 * whether this Mac's tree collides on case with the other Macs', and the
 * final status that decides whether to push.
 */
function clean({
  changed = [] as readonly string[],
  ahead = 0,
}: { changed?: readonly string[]; ahead?: number } = {}): NonNullable<GitScript['status']> {
  return [
    said(statusText()),
    said(statusText()),
    said(statusText()),
    said(statusText({ changed })),
    // `behind: 1`: otherwise mergeFromOrigin sees nothing behind and never
    // attempts the merge at all.
    said(statusText({ behind: 1 })),
    said(statusText({ ahead })),
  ];
}

/**
 * A run where the merge freshly hits conflicts: the same six steps as
 * {@link clean}, with a seventh status — read after the merge fails — that
 * lists them. `sides` gives each `path` conflicting its actual text, so a
 * copy settled from it is written with the same text `writeFromIndex` is
 * asked to write — a real blob id, not a placeholder shared by every test.
 */
function conflicted(
  conflicts: readonly { path: string; code: string }[],
  {
    changed = ['Mine.md'] as readonly string[],
    ahead = 2,
    sides = {} as Record<string, { ours: string; theirs: string }>,
  } = {},
): GitScript {
  const withBlobs = conflicts.map((conflict) => {
    const side = sides[conflict.path];
    return side === undefined
      ? conflict
      : { ...conflict, oursOid: fakeBlob(side.ours), theirsOid: fakeBlob(side.theirs) };
  });
  return {
    status: [
      said(statusText()),
      said(statusText()),
      said(statusText()),
      said(statusText({ changed })),
      // `behind: 1`: otherwise mergeFromOrigin never attempts the merge.
      said(statusText({ behind: 1 })),
      said(statusText({ conflicts: withBlobs })),
      said(statusText({ ahead })),
    ],
    merge: failed('CONFLICT (content): Merge conflict in Ideas.md'),
  };
}

describe('syncNow', () => {
  it('writes unsaved typing before anything is committed, then commits, fetches, merges and pushes', async () => {
    const { run, calls, flushed } = setUp({
      script: {
        status: clean({ changed: ['Today.md'], ahead: 1 }),
        head: [said('old'), said('new')],
      },
    });
    const report = await run();
    expect(flushed).toEqual(['flushed before 0 git calls']);
    expect(calls.map(({ method }) => method).slice(0, 3)).toEqual([
      'currentBranch',
      'status',
      'status',
    ]);
    expect(calls.find(({ method }) => method === 'commit')?.args).toEqual({
      message: 'Atlas sync from Studio 2026-09-28 14:05',
      identity: null,
    });
    expect(calls.find(({ method }) => method === 'merge')?.args).toEqual({
      branch: 'main',
      identity: null,
    });
    expect(report).toEqual({
      at: 1_000,
      committed: true,
      pulled: true,
      pushed: true,
      conflicts: [],
      notSynced: [],
      ignored: [],
    });
  });

  it('commits nothing and pushes nothing when nothing changed on either side', async () => {
    const { run, called, activity } = setUp();
    const report = await run();
    expect(called('commit')).toHaveLength(0);
    expect(called('push')).toHaveLength(0);
    expect(report).toMatchObject({ committed: false, pulled: false, pushed: false });
    expect(activity.reports).toEqual([
      { level: 'info', kind: 'sync', message: 'Synced: nothing had changed.', subject: null },
    ]);
  });

  it('skips the merge entirely when nothing is behind, rather than merging an unchanged branch', async () => {
    // `statusText()`'s defaults (an upstream, 0 ahead, 0 behind) are exactly
    // this: nothing new from the other Macs, so there is nothing to compare
    // trees for or merge.
    const { run, called } = setUp();
    const report = await run();
    expect(report.pulled).toBe(false);
    expect(called('tree')).toHaveLength(0);
    expect(called('mergeBase')).toHaveLength(0);
    expect(called('merge')).toHaveLength(0);
  });

  it('attempts the merge when something is behind, even with nothing else changed', async () => {
    const { run, called } = setUp({
      script: {
        status: [
          said(statusText()),
          said(statusText()),
          said(statusText()),
          said(statusText()),
          said(statusText({ behind: 1 })),
          said(statusText()),
        ],
      },
    });
    await run();
    expect(called('merge')).toHaveLength(1);
  });

  it('pushes a branch GitHub does not have yet, without merging', async () => {
    const { run, called } = setUp({
      script: {
        remoteBranchExists: failed('', 1),
        status: [
          said(statusText()),
          said(statusText()),
          said(statusText()),
          said(statusText()),
          said(statusText({ upstream: null })),
        ],
      },
    });
    const report = await run();
    expect(called('merge')).toHaveLength(0);
    expect(called('push')).toHaveLength(1);
    expect(report.pushed).toBe(true);
  });

  it('commits as this Mac when git on it has no name of its own', async () => {
    const { run, called } = setUp({
      script: {
        status: clean({ changed: ['a.md'] }),
        config: [said(''), said('')],
      },
    });
    await run();
    expect(called('commit')[0]?.args).toMatchObject({
      identity: { name: 'DFAI on Studio', email: 'dfai@studio.local' },
    });
  });

  it('merges as this Mac when git on it has no name of its own (#87)', async () => {
    const { run, called } = setUp({
      script: {
        status: clean({ changed: ['a.md'], ahead: 1 }),
        config: [said(''), said('')],
        head: [said('old'), said('new')],
      },
    });
    await run();
    expect(called('merge')[0]?.args).toEqual({
      branch: 'main',
      identity: { name: 'DFAI on Studio', email: 'dfai@studio.local' },
    });
  });

  it('keeps this Mac’s note in place and saves the other Mac’s beside it, with no conflict markers', async () => {
    const sides = { 'Projects/Ideas.md': { ours: 'mine\n', theirs: 'theirs\n' } };
    const { run, files, activity } = setUp({
      script: conflicted([{ path: 'Projects/Ideas.md', code: 'UU' }], { sides }),
      files: { 'Projects/Ideas.md': MARKED },
      sides,
    });
    const report = await run();
    expect(files.get('Projects/Ideas.md')).toBe('mine\n');
    expect(files.get('Projects/Ideas (conflict from Laptop).md')).toBe('theirs\n');
    for (const text of files.values()) expect(text).not.toMatch(MARKERS);
    expect(report.conflicts).toEqual([
      {
        path: 'Projects/Ideas.md',
        copy: 'Projects/Ideas (conflict from Laptop).md',
        whose: 'theirs',
      },
    ]);
    expect(report.pulled).toBe(true);
    expect(activity.reports.map(({ level }) => level)).toEqual(['warning', 'warning']);
    expect(activity.reports[1]).toMatchObject({
      subject: { kind: 'note', path: 'Projects/Ideas (conflict from Laptop).md' },
    });
  });

  it('names the copy of a web edit for the web, as the web names its own (#665)', async () => {
    const sides = { 'Projects/Ideas.md': { ours: 'mine\n', theirs: 'from the web\n' } };
    const { run, files } = setUp({
      script: {
        ...conflicted([{ path: 'Projects/Ideas.md', code: 'UU' }], { sides }),
        remoteSubject: said('Save Projects/Ideas.md\n'),
        remoteAuthor: said('DFAI web\n'),
      },
      files: { 'Projects/Ideas.md': MARKED },
      sides,
    });
    await run();
    expect(files.get('Projects/Ideas.md')).toBe('mine\n');
    expect(files.get('Projects/Ideas (conflict from DFAI web).md')).toBe('from the web\n');
  });

  it('copies an attachment both Macs changed the same way, bytes as git wrote them', async () => {
    const sides = { 'Attachments/photo.png': { ours: 'PNG-mine', theirs: 'PNG-theirs' } };
    const { run, files, activity } = setUp({
      script: conflicted([{ path: 'Attachments/photo.png', code: 'AA' }], { sides }),
      files: { 'Attachments/photo.png': 'PNG-mine' },
      sides,
    });
    await run();
    expect(files.get('Attachments/photo.png')).toBe('PNG-mine');
    expect(files.get('Attachments/photo (conflict from Laptop).png')).toBe('PNG-theirs');
    // An image has no page, so its line opens nothing.
    expect(activity.reports[1]?.subject).toBeNull();
  });

  it('keeps the other Mac’s settings out of the live settings, in the conflicts folder', async () => {
    const sides = { '.atlas/settings.md': { ours: 'syncInterval: 5', theirs: 'syncInterval: 10' } };
    const { run, files } = setUp({
      script: conflicted([{ path: '.atlas/settings.md', code: 'UU' }], { sides }),
      files: { '.atlas/settings.md': MARKED },
      sides,
    });
    await run();
    expect(files.get('.atlas/settings.md')).toBe('syncInterval: 5');
    expect(files.get('Sync conflicts/atlas/settings (conflict from Laptop).md')).toBe(
      'syncInterval: 10',
    );
  });

  it('never writes a copy over a file already there', async () => {
    const sides = { 'Ideas.md': { ours: 'mine', theirs: 'theirs' } };
    const { run, files } = setUp({
      script: {
        ...conflicted([{ path: 'Ideas.md', code: 'UU' }], { sides }),
        // The domain avoids a name already taken; it learns of one from the
        // index, not from the vault's own files, so the fake is told here.
        indexEntries: said(
          '100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tIdeas (conflict from Laptop).md\0',
        ),
      },
      files: { 'Ideas.md': MARKED, 'Ideas (conflict from Laptop).md': 'an older copy' },
      sides,
    });
    await run();
    expect(files.get('Ideas (conflict from Laptop).md')).toBe('an older copy');
    expect(files.get('Ideas (conflict from Laptop) 2.md')).toBe('theirs');
  });

  it('keeps whichever side still has a file one Mac deleted and the other changed', async () => {
    const { run, called } = setUp({
      script: conflicted([
        { path: 'Edited here.md', code: 'UD' },
        { path: 'Edited there.md', code: 'DU' },
        { path: 'Gone.md', code: 'DD' },
      ]),
      // This Mac's changed file is in the vault; the one it deleted is not.
      files: { 'Edited here.md': 'typed here since' },
    });
    const report = await run();
    // Git writes only the file this Mac no longer has; this Mac's own is left as it is.
    expect(called('checkout').map(({ args }) => args)).toEqual([
      { side: 'theirs', path: 'Edited there.md', seen: null },
    ]);
    expect(report.conflicts).toEqual([]);
    // The merge is concluded even though nothing new was staged for it.
    expect(called('commit')).toHaveLength(2);
  });

  it('puts this Mac’s file back, untouched, when git cannot save the other side', async () => {
    // The old flow wrote both sides through `checkout`, so the same failure
    // there stood in for git refusing the write. The copy is now written
    // through the index (`stageBlob` + `writeFromIndex`), so that is what
    // is failed here to mean the same thing: git could not save the copy.
    const { run, files, called } = setUp({
      script: {
        ...conflicted([{ path: 'Ideas.md', code: 'UU' }]),
        writeFromIndex: failed('error: could not write the object'),
      },
      files: { 'Ideas.md': MARKED },
    });
    await expect(run()).rejects.toThrow('save the other Mac’s version');
    expect(files.get('Ideas.md')).toBe(MARKED);
    expect([...files.keys()]).toEqual(['Ideas.md']);
    expect(called('push')).toHaveLength(0);
  });

  it('keeps a file this Mac made again after deleting it, rather than the other Mac’s', async () => {
    const { run, files, called } = setUp({
      script: conflicted([{ path: 'Back again.md', code: 'DU' }]),
      files: { 'Back again.md': 'written here again' },
      sides: { 'Back again.md': { ours: '', theirs: 'theirs' } },
    });
    await run();
    expect(files.get('Back again.md')).toBe('written here again');
    expect(called('checkout')).toHaveLength(0);
  });

  it('keeps a binary file as it is in the vault, git having written no markers into it', async () => {
    const sides = { 'Scan.pdf': { ours: 'PDF-mine', theirs: 'PDF-theirs' } };
    const { run, files } = setUp({
      script: conflicted([{ path: 'Scan.pdf', code: 'UU' }], { sides }),
      files: { 'Scan.pdf': 'PDF-mine' },
      sides,
    });
    await run();
    expect(files.get('Scan.pdf')).toBe('PDF-mine');
    expect(files.get('Scan (conflict from Laptop).pdf')).toBe('PDF-theirs');
  });

  it('settles a merge a quit cut short before committing anything new', async () => {
    // Blobs that are the sides' own text, so the copy is written as git would.
    const cutShort = {
      path: 'Ideas.md',
      code: 'UU',
      oursOid: fakeBlob('mine'),
      theirsOid: fakeBlob('theirs'),
    };
    const { run, files, called } = setUp({
      script: {
        status: [
          said(statusText({ conflicts: [cutShort] })),
          said(statusText({ conflicts: [cutShort] })),
          said(statusText()),
          said(statusText()),
          said(statusText()),
          said(statusText({ ahead: 1 })),
        ],
        // The merge the quit cut short still waits to be committed.
        mergeInProgress: said('abc\n'),
      },
      files: { 'Ideas.md': MARKED },
      sides: { 'Ideas.md': { ours: 'mine', theirs: 'theirs' } },
    });
    const report = await run();
    expect(files.get('Ideas.md')).toBe('mine');
    expect(report.conflicts).toHaveLength(1);
    expect(report.committed).toBe(true);
    expect(called('commit')).toHaveLength(1);
  });

  it('stops, and says why, when a merge fails for a reason other than conflicts', async () => {
    const { run, called, activity } = setUp({
      script: {
        status: clean(),
        merge: failed('error: Your local changes would be overwritten by merge'),
      },
    });
    await expect(run()).rejects.toThrow(SyncError);
    expect(called('push')).toHaveLength(0);
    expect(activity.reports[0]).toMatchObject({ level: 'error', kind: 'sync' });
    expect(activity.reports[0]?.message).toContain('Your local changes would be overwritten');
  });

  it('explains a rejected login and records it', async () => {
    const { run, activity } = setUp({
      script: {
        fetch: failed(
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
          128,
        ),
      },
    });
    await expect(run()).rejects.toThrow('gh auth setup-git');
    expect(activity.reports[0]?.message).toContain('Sync failed: GitHub didn’t accept');
  });

  it('says how to install git when the Mac has none', async () => {
    const { run } = setUp({
      script: {
        status: () => {
          throw new ProgramMissingError('git');
        },
      },
    });
    await expect(run()).rejects.toThrow('xcode-select --install');
  });

  it('refuses to sync a detached HEAD', async () => {
    const { run } = setUp({
      script: { currentBranch: failed('fatal: ref HEAD is not a symbolic ref') },
    });
    await expect(run()).rejects.toThrow('isn’t on a branch');
  });

  it('reports a push GitHub refused', async () => {
    const { run } = setUp({
      script: {
        status: clean({ changed: ['a.md'], ahead: 1 }),
        push: failed('! [rejected] main -> main (fetch first)'),
      },
    });
    await expect(run()).rejects.toThrow('Git could not push to GitHub');
  });

  it('keeps each step’s success from hiding a later failure', async () => {
    const { run } = setUp({ script: { addAll: OK, fetch: failed('fatal: boom') } });
    await expect(run()).rejects.toThrow('Git could not fetch from GitHub: boom');
  });

  it('folds unpushed commits holding a file over GitHub’s limit into one, and leaves the file out', async () => {
    const large = 'e'.repeat(40);
    const { run, activity, called } = setUp({
      script: {
        largeUnpushed: said(`~${large}\n`),
        indexEntries: said(`100644 ${large} 0\tBig.bin\0`),
      },
    });
    const report = await run();
    expect(called('resetSoftTo').map(({ args }) => args)).toEqual(['main']);
    expect(called('unstage').map(({ args }) => args)).toEqual(['Big.bin']);
    expect(
      activity.reports.some((r) => r.message.includes('Big.bin') && r.level === 'warning'),
    ).toBe(true);
    // `notSynced` is not covered above: see the BUG test just below.
    void report;
  });

  // BUG (found writing tests for A29-01, not fixed here per instructions): the
  // report's `notSynced` is built from the `leftOut` `leaveOut` computed at the
  // *start* of the sync, before `leaveOutOfUnpushedHistory` finds a file large
  // only in unpushed history and adds it to the exclude file. That file is
  // warned about in the Activity log and excluded from staging, but never
  // appears in `SyncReport.notSynced` for this sync — the sidebar/report the
  // person sees this sync would not say it stayed unsynced, only the log would.
  // Fix: fold `leaveOutOfUnpushedHistory`'s `without` back into what `runSync`
  // reports, not just what it writes to the exclude file.
  it('reports a file only large in unpushed history as not synced, the same sync it is found', async () => {
    const large = 'e'.repeat(40);
    const { run } = setUp({
      script: {
        largeUnpushed: said(`~${large}\n`),
        indexEntries: said(`100644 ${large} 0\tBig.bin\0`),
      },
    });
    const report = await run();
    expect(report.notSynced).toEqual(['Big.bin']);
  });

  it('stops the fold, and says why, when nothing has reached GitHub yet to go back to', async () => {
    const large = 'e'.repeat(40);
    const { run } = setUp({
      script: {
        largeUnpushed: said(`~${large}\n`),
        indexEntries: said(`100644 ${large} 0\tBig.bin\0`),
        remoteBranchExists: failed('', 1),
      },
    });
    await expect(run()).rejects.toThrow('over GitHub’s 100 MB limit');
  });

  it('leaves out a folder that is a repository of its own', async () => {
    const { run, activity } = setUp({
      script: {
        status: [
          said(statusText({ untracked: ['vendor/'] })),
          said(statusText()),
          said(statusText()),
          said(statusText()),
          said(statusText()),
          said(statusText({ ahead: 0 })),
        ],
      },
    });
    const report = await run();
    expect(report.notSynced).toEqual(['vendor/']);
    expect(
      activity.reports.some((r) => r.message.includes('vendor') && r.level === 'warning'),
    ).toBe(true);
  });
});
