// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import {
  createOwnWrites,
  fakeHostVaultFs,
  type HostVaultFsPort,
  type VaultWatchPort,
} from '@dfai/application';
import { boundToVault } from './bound-to-vault.ts';
import { useOutsideChanges } from './use-outside-changes.ts';

const VAULT_A = '/vaults/larkspur';
const VAULT_B = '/vaults/quill';
const NOTE = 'Notes/Plan.md';
const SAVE_REPORT = ['Notes/.Plan.md.atlas-tmp', NOTE];

/** The host: one disk per vault, written at a clock the test holds still, and a watcher the test speaks for. */
function aHost() {
  const disks = new Map<string, Map<string, { text: string; modified: number }>>();
  const diskOf = (vault: string) => disks.get(vault) ?? disks.set(vault, new Map()).get(vault)!;
  const state = { open: VAULT_A, failReads: false };
  const fs: HostVaultFsPort = fakeHostVaultFs({
    readNotes: async (paths) => {
      if (state.failReads) throw new Error('the host is busy');
      return paths.flatMap((path) => {
        const file = diskOf(state.open).get(path);
        return file === undefined ? [] : [{ path, ...file, size: file.text.length }];
      });
    },
    writeTextFile: async ({ path, contents, vault }) => {
      diskOf(vault).set(path, { text: contents, modified: 1_000 });
      return 1_000;
    },
  });
  let heard: ((paths: readonly string[]) => void) | null = null;
  const watch: VaultWatchPort = {
    start: async () => {},
    onChange: async (handler) => {
      heard = handler;
      return () => void (heard = null);
    },
  };
  return {
    fs,
    watch,
    state,
    outsideWrite: (path: string, text: string) =>
      diskOf(state.open).set(path, { text, modified: 1_000 }),
    report: async (paths: readonly string[]) => {
      await waitFor(() => expect(heard).not.toBeNull());
      await act(async () => {
        heard?.(paths);
        // One turn of the event loop: every read the report asked for has answered.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

function watching(
  host: ReturnType<typeof aHost>,
  settled?: () => Promise<unknown>,
  giveUp?: () => Promise<unknown>,
) {
  const ownWrites = createOwnWrites({ clock: { now: () => 50_000 } });
  const onChange = vi.fn();
  const rendered = renderHook(
    ({ vaultKey }: { vaultKey: string }) => {
      const { fs } = boundToVault({ fs: host.fs }, vaultKey, ownWrites);
      useOutsideChanges({
        watch: host.watch,
        vaultKey,
        fs,
        ownWrites,
        onChange,
        ...(settled !== undefined && { settled }),
        ...(giveUp !== undefined && { giveUp }),
      });
      return fs;
    },
    { initialProps: { vaultKey: VAULT_A } },
  );
  /** A save the app then refreshed for, as a tick or a drag is. */
  const save = async (contents: string) => {
    await rendered.result.current.writeTextFile({
      path: createVaultPath(NOTE),
      contents,
      expectedModified: null,
    });
    ownWrites.refreshed({ vault: VAULT_A, through: ownWrites.lastWrite() });
  };
  return { onChange, rendered, save, ownWrites };
}

describe('useOutsideChanges (#254)', () => {
  it('asks for nothing on the echo of the app’s own save', async () => {
    const host = aHost();
    const { onChange, save } = watching(host);
    await save('# Plan\n');
    await host.report(SAVE_REPORT);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still hears another program’s save in the same millisecond', async () => {
    const host = aHost();
    const { onChange, save } = watching(host);
    await save('# Plan\n');
    host.outsideWrite(NOTE, '# Plan, theirs\n');
    await host.report(SAVE_REPORT);
    expect(onChange).toHaveBeenCalledExactlyOnceWith([NOTE]);
  });

  it('hears the report in the vault opened next as a change, whatever was written in the last', async () => {
    const host = aHost();
    const { onChange, rendered, save } = watching(host);
    await save('# Plan\n');
    host.state.open = VAULT_B;
    rendered.rerender({ vaultKey: VAULT_B });
    host.outsideWrite(NOTE, '# Plan\n');
    await host.report([NOTE]);
    expect(onChange).toHaveBeenCalledExactlyOnceWith([NOTE]);
  });

  it('hears every path when the host cannot say what is there', async () => {
    const host = aHost();
    const { onChange, save } = watching(host);
    await save('# Plan\n');
    host.state.failReads = true;
    await host.report(SAVE_REPORT);
    // The temporary is the app's either way; the note could not be told.
    expect(onChange).toHaveBeenCalledExactlyOnceWith([NOTE]);
  });

  it('judges a report once the refresh already asked has run, so a busy window walks once', async () => {
    const host = aHost();
    let refreshDone = () => {};
    const refreshing = new Promise<void>((resolve) => (refreshDone = resolve));
    const { onChange, rendered, ownWrites } = watching(host, () => refreshing);
    await rendered.result.current.writeTextFile({
      path: createVaultPath(NOTE),
      contents: '# Plan\n',
      expectedModified: null,
    });
    // The echo arrives while the app's own refresh for the save is still running.
    const began = ownWrites.lastWrite();
    await host.report(SAVE_REPORT);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      ownWrites.refreshed({ vault: VAULT_A, through: began });
      refreshDone();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still judges the report when the refresh it waited on failed', async () => {
    const host = aHost();
    const { onChange } = watching(host, () => Promise.reject(new Error('the index is busy')));
    host.outsideWrite(NOTE, '# Plan, theirs\n');
    await host.report([NOTE]);
    expect(onChange).toHaveBeenCalledExactlyOnceWith([NOTE]);
  });

  it('hears every path when telling them apart throws', async () => {
    const host = aHost();
    const { onChange, save } = watching(host);
    await save('# Plan\n');
    host.fs.readNotes = () => {
      throw new Error('the host went away');
    };
    await host.report(SAVE_REPORT);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(SAVE_REPORT);
  });

  it('passes on a report of another program’s change at once, while a sync is still running', async () => {
    const host = aHost();
    const running = () => new Promise<never>(() => {});
    const { onChange } = watching(host, running, running);
    host.outsideWrite('Notes/Theirs.md', '# Theirs\n');
    await host.report(['Notes/Theirs.md']);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(['Notes/Theirs.md']);
  });

  it('waits only so long for a sync that never ends, then judges the report', async () => {
    const host = aHost();
    let giveUpNow = () => {};
    const given = new Promise<void>((resolve) => (giveUpNow = resolve));
    const { onChange, rendered } = watching(
      host,
      () => new Promise<never>(() => {}),
      () => given,
    );
    await rendered.result.current.writeTextFile({
      path: createVaultPath(NOTE),
      contents: '# Plan\n',
      expectedModified: null,
    });
    await host.report(SAVE_REPORT);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      giveUpNow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Not refreshed for by the app, so its echo is what refreshes it.
    expect(onChange).toHaveBeenCalledExactlyOnceWith([NOTE]);
  });
});
