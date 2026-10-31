// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { VaultEntry, VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type VaultFsPort } from '@dfai/application';
import { useVaultEntries, type VaultEntryPorts } from './use-vault-entries.ts';

const NOTE = 'Notes/Plan.md' as VaultPath;

function ports(
  reload: () => Promise<void>,
  fs: VaultFsPort = fakeVaultFs({ moveEntry: async () => {} }),
): VaultEntryPorts {
  return {
    fs,
    index: fakeIndexPort(),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: vi.fn(),
      abandon: () => {},
      reload: vi.fn(),
    },
    tree: { reload, expandDirectory: vi.fn(), forgetDirectory: vi.fn(), isExpanded: () => false },
    closeNotes: vi.fn(),
    refresh: vi.fn(),
    createNoteIn: async () => {},
    overlay: { show: vi.fn(), hide: vi.fn() },
  };
}

describe('useVaultEntries', () => {
  it('says so when the tree cannot be re-read after a rename', async () => {
    const reload = vi.fn(() => Promise.reject(new Error('the folder could not be read')));
    const { result } = renderHook(() => useVaultEntries(ports(reload), [NOTE]));
    act(() => result.current.rename({ kind: 'file', path: NOTE }, 'Roadmap'));
    await waitFor(() => expect(result.current.notice).toBe('the folder could not be read'));
    expect(reload).toHaveBeenCalled();
  });

  it('offers to update the links a rename left behind, and updates them when asked', async () => {
    const disk = new Map([
      ['Notes/Plan.md', '# Plan\n'],
      ['a.md', 'See [[Plan]] and [[Plan|the plan]].\n'],
      ['b.md', 'Also [[Plan]].\n'],
    ]);
    const fs = fakeVaultFs({
      moveEntry: async ({ from, to }) => {
        disk.set(to, disk.get(from) ?? '');
        disk.delete(from);
      },
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: disk.get(path) ?? '', modified: 1, size: 1 })),
      readTextFile: async (path) => ({ text: disk.get(path) ?? '', modified: 1 }),
      writeTextFile: async ({ path, contents }) => {
        disk.set(path, contents);
        return 2;
      },
    });
    const notes = ['Notes/Plan.md', 'a.md', 'b.md'] as VaultPath[];
    const { result } = renderHook(() =>
      useVaultEntries(
        ports(async () => {}, fs),
        notes,
      ),
    );

    act(() => result.current.rename({ kind: 'file', path: NOTE }, 'Roadmap'));
    await waitFor(() => expect(result.current.links).not.toBeNull());
    expect(result.current.links?.text).toBe('3 links in 2 notes still point at “Plan”.');
    expect(result.current.links?.action).toBe('Update 3 links');
    // Nothing is rewritten until the person says so.
    expect(disk.get('a.md')).toBe('See [[Plan]] and [[Plan|the plan]].\n');

    act(() => result.current.links?.update());
    await waitFor(() => expect(result.current.links).toBeNull());
    expect(disk.get('a.md')).toBe('See [[Roadmap]] and [[Roadmap|the plan]].\n');
    expect(disk.get('b.md')).toBe('Also [[Roadmap]].\n');
  });

  it('says which notes kept their old links, a chat note as one rather than by its question', async () => {
    const CHAT = 'Chats/Should Mara Quill get a raise.md';
    const disk = new Map([
      ['Notes/Plan.md', '# Plan\n'],
      [CHAT, 'See [[Plan]].\n'],
      ['b.md', 'Also [[Plan]].\n'],
    ]);
    const fs = fakeVaultFs({
      moveEntry: async ({ from, to }) => {
        disk.set(to, disk.get(from) ?? '');
        disk.delete(from);
      },
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: disk.get(path) ?? '', modified: 1, size: 1 })),
      readTextFile: async (path) => ({ text: disk.get(path) ?? '', modified: 1 }),
      writeTextFile: async () => {
        throw new Error('the disk is full');
      },
    });
    const notes = ['Notes/Plan.md', CHAT, 'b.md'] as VaultPath[];
    const { result } = renderHook(() =>
      useVaultEntries(
        ports(async () => {}, fs),
        notes,
      ),
    );
    act(() => result.current.rename({ kind: 'file', path: NOTE }, 'Roadmap'));
    await waitFor(() => expect(result.current.links).not.toBeNull());
    act(() => result.current.links?.update());

    await waitFor(() => expect(result.current.notice).toMatch(/could not be updated/));
    expect(result.current.notice).toContain('a chat note (the disk is full)');
    expect(result.current.notice).toContain('b (the disk is full)');
    expect(result.current.notice).not.toContain('Mara Quill');
  });

  it('says a chat note held unsaved typing without its question, in the name or the reason', async () => {
    const CHAT = 'Chats/Should Mara Quill get a raise.md';
    const disk = new Map([
      ['Notes/Plan.md', '# Plan\n'],
      [CHAT, 'See [[Plan]].\n'],
    ]);
    const fs = fakeVaultFs({
      moveEntry: async ({ from, to }) => {
        disk.set(to, disk.get(from) ?? '');
        disk.delete(from);
      },
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: disk.get(path) ?? '', modified: 1, size: 1 })),
      readTextFile: async (path) => ({ text: disk.get(path) ?? '', modified: 1 }),
      writeTextFile: async () => 2,
    });
    const typing = ports(async () => {}, fs);
    const editors = {
      ...typing.editors,
      state: (at: VaultPath) => (at === CHAT ? 'dirty' : 'closed'),
    };
    const { result } = renderHook(() =>
      useVaultEntries(
        { ...typing, editors } as VaultEntryPorts,
        ['Notes/Plan.md', CHAT] as VaultPath[],
      ),
    );
    act(() => result.current.rename({ kind: 'file', path: NOTE }, 'Roadmap'));
    await waitFor(() => expect(result.current.links).not.toBeNull());
    act(() => result.current.links?.update());

    await waitFor(() =>
      expect(result.current.notice).toBe(
        '1 note could not be updated: a chat note (The note has unsaved changes.).',
      ),
    );
  });

  it('warns of a name a chat note now shares without saying the name, which is the question', async () => {
    const DEEP = 'Notes/Drafts/Plan.md' as VaultPath;
    const CHAT = 'Chats/Should Mara Quill get a raise.md' as VaultPath;
    const { result } = renderHook(() =>
      useVaultEntries(
        ports(async () => {}),
        [DEEP, CHAT],
      ),
    );
    act(() => result.current.rename({ kind: 'file', path: DEEP }, 'Should Mara Quill get a raise'));

    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(result.current.notice).toBe(
      'More than one note now shares a name with a chat note; links to that name open the chat note.',
    );
  });

  it('names a shared name, and the note it opens, when that note is no chat', async () => {
    const DEEP = 'Notes/Drafts/Plan.md' as VaultPath;
    const ROADMAP = 'Roadmap.md' as VaultPath;
    const { result } = renderHook(() =>
      useVaultEntries(
        ports(async () => {}),
        [DEEP, ROADMAP],
      ),
    );
    act(() => result.current.rename({ kind: 'file', path: DEEP }, 'Roadmap'));

    await waitFor(() =>
      expect(result.current.notice).toBe(
        'More than one note is called “Roadmap”: [[Roadmap]] now opens Roadmap.md.',
      ),
    );
  });

  it('leaves the links as they are when the offer is dismissed', async () => {
    const disk = new Map([['a.md', '[[Plan]]']]);
    const fs = fakeVaultFs({
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: disk.get(path) ?? '', modified: 1, size: 1 })),
      writeTextFile: vi.fn(async () => 2),
    });
    const notes = ['Notes/Plan.md', 'a.md'] as VaultPath[];
    const { result } = renderHook(() =>
      useVaultEntries(
        ports(async () => {}, fs),
        notes,
      ),
    );
    act(() => result.current.rename({ kind: 'file', path: NOTE }, 'Roadmap'));
    await waitFor(() => expect(result.current.links?.action).toBe('Update 1 link'));
    act(() => result.current.links?.dismiss());
    expect(result.current.links).toBeNull();
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it('asks about a folder reached through a link with why it cannot go, and names links (#169)', async () => {
    const listings: Record<string, VaultEntry[]> = {
      '': [{ kind: 'directory', name: 'Work', path: 'Work' as VaultPath }],
      Work: [
        { kind: 'directory', name: 'Alias', path: 'Work/Alias' as VaultPath, link: true },
        { kind: 'directory', name: 'Shelf', path: 'Work/Shelf' as VaultPath },
      ],
      'Work/Shelf': [
        { kind: 'directory', name: 'garden', path: 'Work/Shelf/garden' as VaultPath, link: true },
      ],
    };
    const fs = fakeVaultFs({ listDirectory: async (path) => listings[path] ?? [] });
    const { result } = renderHook(() =>
      useVaultEntries(
        ports(async () => {}, fs),
        [],
      ),
    );

    act(() =>
      result.current.askDelete({ kind: 'directory', path: 'Work/Alias/Plans' as VaultPath }),
    );
    await waitFor(() => expect(result.current.question?.subject.refusal).toMatch(/“Work\/Alias”/));

    act(() => result.current.askDelete({ kind: 'directory', path: 'Work/Shelf' as VaultPath }));
    await waitFor(() => expect(result.current.question?.subject.links).toEqual(['garden']));
    expect(result.current.question?.subject.refusal ?? null).toBeNull();
  });
});
