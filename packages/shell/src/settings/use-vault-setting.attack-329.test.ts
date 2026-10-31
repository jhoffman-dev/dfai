// @vitest-environment jsdom
/**
 * Attack on #293 (PR #329): one cached read of the settings note shared by
 * every setting, with each setting's write rules on top of it.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, recordingActivity, type VaultFsPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { vaultReadKey } from '../reads/query-client.ts';
import { useVaultSetting } from './use-vault-setting.ts';

const SETTINGS = '.atlas/settings.md';
const noteOf = (value: string) => `---\nvalue: ${value}\n---\n`;
const parse = (settings: Readonly<Record<string, unknown>>) =>
  typeof settings.value === 'string' ? settings.value : null;

const vaultSaying = (value: string): VaultFsPort =>
  fakeVaultFs({
    readNotes: async () => [{ path: SETTINGS, text: noteOf(value), modified: 1, size: 1 }],
  });

/** A write that waits for `land` (or `refuse`) before it settles. */
function heldStore() {
  const pending: { resolve: () => void; reject: (cause: Error) => void }[] = [];
  const store = () =>
    new Promise<void>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return {
    store,
    land: () => pending.shift()?.resolve(),
    refuse: (why: string) => pending.shift()?.reject(new Error(why)),
  };
}

/** Lets promise callbacks run without letting a macrotask (TanStack's notify) through. */
const microtasks = async (count = 30) => {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
};

describe('useVaultSetting across a vault switch with a write still under way (attack-329)', () => {
  it("shows vault B's settings once vault A's write lands after the switch", async () => {
    const writes = heldStore();
    const { wrapper } = queryWrapper();
    const hook = renderHook(
      (props: { fs: VaultFsPort; vaultKey: string }) =>
        useVaultSetting<string>({
          ...props,
          markdown: remarkMarkdown,
          parse,
          store: writes.store,
          activity: recordingActivity(),
        }),
      { wrapper, initialProps: { fs: vaultSaying('from A'), vaultKey: 'a' } },
    );
    await waitFor(() => expect(hook.result.current.value).toBe('from A'));

    act(() => hook.result.current.save('new in A'));
    hook.rerender({ fs: vaultSaying('from B'), vaultKey: 'b' });
    // B's note is read while A's write is still out, and shown: A's write is A's.
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    expect(hook.result.current.value).toBe('from B');
    expect(hook.result.current.loaded).toBe(true);
    // The write lands (or is refused by the switch, as the bound ports do): either way it is over.
    await act(async () => writes.land());
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});

    expect(hook.result.current.value).toBe('from B');
    expect(hook.result.current.loaded).toBe(true);
  });

  it("does not carry vault A's settings-note failure into vault B before B answers", async () => {
    const { wrapper } = queryWrapper();
    let releaseB = () => {};
    const pendingB = fakeVaultFs({
      readNotes: () =>
        new Promise((resolve) => {
          releaseB = () =>
            resolve([{ path: SETTINGS, text: noteOf('from B'), modified: 1, size: 1 }]);
        }),
    });
    const broken = fakeVaultFs({
      readNotes: async () => [
        { path: SETTINGS, text: '---\nvalue: [unclosed\n---\n', modified: 1, size: 1 },
      ],
    });
    const hook = renderHook(
      (props: { fs: VaultFsPort; vaultKey: string }) =>
        useVaultSetting<string>({
          ...props,
          markdown: remarkMarkdown,
          parse,
          store: async () => {},
          activity: recordingActivity(),
        }),
      { wrapper, initialProps: { fs: broken, vaultKey: 'a' } },
    );
    await waitFor(() => expect(hook.result.current.unreadable).not.toBeNull());

    hook.rerender({ fs: pendingB, vaultKey: 'b' });
    expect(hook.result.current.answered).toBe(false);
    expect(hook.result.current.unreadable).toBeNull();
    act(() => releaseB());
    await waitFor(() => expect(hook.result.current.value).toBe('from B'));
  });

  it("does not show vault A's failed save as vault B's problem", async () => {
    const writes = heldStore();
    const { wrapper } = queryWrapper();
    const hook = renderHook(
      (props: { fs: VaultFsPort; vaultKey: string }) =>
        useVaultSetting<string>({
          ...props,
          markdown: remarkMarkdown,
          parse,
          store: writes.store,
          activity: recordingActivity(),
        }),
      { wrapper, initialProps: { fs: vaultSaying('from A'), vaultKey: 'a' } },
    );
    await waitFor(() => expect(hook.result.current.value).toBe('from A'));
    act(() => hook.result.current.save('new in A'));
    hook.rerender({ fs: vaultSaying('from B'), vaultKey: 'b' });
    await act(async () => writes.refuse('The vault was switched before the write landed.'));
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});

    expect(hook.result.current.problem).toBeNull();
  });
});

describe('useVaultSetting and a read that lands as its write does (attack-329)', () => {
  it('never shows the value from before the write once it has been saved', async () => {
    const file = { value: 'before' };
    // While held, each read waits to be answered with what the file held when it was asked.
    let holding = false;
    const asked: (() => void)[] = [];
    const fs = fakeVaultFs({
      readNotes: () => {
        const text = noteOf(file.value);
        const answer = [{ path: SETTINGS, text, modified: 1, size: 1 }];
        if (!holding) return Promise.resolve(answer);
        return new Promise((resolve) => asked.push(() => resolve(answer)));
      },
    });
    const writes = heldStore();
    const shown: (string | null)[] = [];
    const { wrapper, client } = queryWrapper();
    const hook = renderHook(
      () => {
        const setting = useVaultSetting<string>({
          fs,
          markdown: remarkMarkdown,
          parse,
          store: writes.store,
          vaultKey: 'a',
          activity: recordingActivity(),
        });
        shown.push(setting.value);
        return setting;
      },
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.value).toBe('before'));

    act(() => hook.result.current.save('after'));
    holding = true;
    // An outside edit to another setting reads the note again before this write lands.
    act(() => void client.invalidateQueries({ queryKey: vaultReadKey('a', 'settings') }));
    await act(async () => {
      // That read answers with the note from before the write; in the same task the write lands.
      asked.shift()?.();
      await microtasks();
      file.value = 'after';
      writes.land();
      await microtasks();
    });
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    // The read after the write is answered.
    await act(async () => {
      for (const answer of asked.splice(0)) answer();
      await microtasks();
    });
    await waitFor(() => expect(hook.result.current.value).toBe('after'));

    const afterSave = shown.slice(shown.indexOf('after'));
    expect(afterSave).not.toContain('before');
  });
});
