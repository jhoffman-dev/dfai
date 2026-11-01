// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, recordingActivity, type VaultFsPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useVaultSetting } from './use-vault-setting.ts';

const SETTINGS = '.atlas/settings.md';
const noteOf = (value: string) => `---\nvalue: ${value}\n---\n`;
const parse = (settings: Readonly<Record<string, unknown>>) =>
  typeof settings.value === 'string' ? settings.value : null;

/** A vault whose settings note says `value`. */
function vaultSaying(value: string): VaultFsPort {
  return fakeVaultFs({
    readNotes: async () => [{ path: SETTINGS, text: noteOf(value), modified: 1, size: 1 }],
  });
}

/** A vault whose settings note does not answer until `release`, or fails when `fail` is called. */
function pendingVault(value: string) {
  let release = () => {};
  let fail: (cause: Error) => void = () => {};
  const fs = fakeVaultFs({
    readNotes: () =>
      new Promise((resolve, reject) => {
        release = () => resolve([{ path: SETTINGS, text: noteOf(value), modified: 1, size: 1 }]);
        fail = reject;
      }),
  });
  return { fs, release: () => release(), fail: (cause: Error) => fail(cause) };
}

function renderSetting(
  initial: { fs: VaultFsPort; vaultKey: string },
  /** What the settings note's writer says to every save, when it says no. */
  refuse: string | null = null,
) {
  const stored: { next: string; previous: string | null }[] = [];
  const activity = recordingActivity();
  const { wrapper, client } = queryWrapper();
  const hook = renderHook(
    (props: { fs: VaultFsPort; vaultKey: string }) =>
      useVaultSetting<string>({
        ...props,
        markdown: remarkMarkdown,
        parse,
        activity,
        store: (next, previous) => {
          if (refuse !== null) return Promise.reject(new Error(refuse));
          stored.push({ next, previous });
          return Promise.resolve();
        },
      }),
    { wrapper, initialProps: initial },
  );
  return { hook, stored, activity, client };
}

describe('useVaultSetting across a vault switch', () => {
  it("does not hand out vault A's value while vault B is read", async () => {
    const { hook } = renderSetting({ fs: vaultSaying('from A'), vaultKey: 'a' });
    await waitFor(() => expect(hook.result.current.value).toBe('from A'));

    const b = pendingVault('from B');
    hook.rerender({ fs: b.fs, vaultKey: 'b' });
    expect(hook.result.current.loaded).toBe(false);
    expect(hook.result.current.value).toBeNull();

    act(() => b.release());
    await waitFor(() => expect(hook.result.current.value).toBe('from B'));
    expect(hook.result.current.loaded).toBe(true);
  });

  it("does not hand out vault A's value when vault B cannot be read", async () => {
    const { hook } = renderSetting({ fs: vaultSaying('from A'), vaultKey: 'a' });
    await waitFor(() => expect(hook.result.current.value).toBe('from A'));

    const b = pendingVault('never');
    hook.rerender({ fs: b.fs, vaultKey: 'b' });
    act(() => b.fail(new Error('settings.md: two keys named profileName')));
    await waitFor(() => expect(hook.result.current.unreadable).toContain('settings.md'));
    expect(hook.result.current.value).toBeNull();
    expect(hook.result.current.answered).toBe(true);
  });

  it('hands the store the value it replaces in this vault, and none from another', async () => {
    const { hook, stored } = renderSetting({ fs: vaultSaying('from A'), vaultKey: 'a' });
    await waitFor(() => expect(hook.result.current.value).toBe('from A'));
    act(() => hook.result.current.save('new in A'));

    const b = pendingVault('from B');
    hook.rerender({ fs: b.fs, vaultKey: 'b' });
    act(() => hook.result.current.save('new in B'));

    expect(stored).toEqual([
      { next: 'new in A', previous: 'from A' },
      { next: 'new in B', previous: null },
    ]);
  });
});

describe('useVaultSetting and its writes', () => {
  /** A vault whose settings note holds what the last write landed, and whose writes wait for `land`. */
  function writableVault() {
    const file = { value: 'before' };
    const landing: (() => void)[] = [];
    const fs = fakeVaultFs({
      readNotes: async () => [{ path: SETTINGS, text: noteOf(file.value), modified: 1, size: 1 }],
    });
    const store = (next: string) =>
      new Promise<void>((resolve) => {
        landing.push(() => {
          file.value = next;
          resolve();
        });
      });
    return { fs, file, store, land: () => landing.shift()?.() };
  }

  it('sets aside a read that lands while a write is under way, and shows the write', async () => {
    const vault = writableVault();
    const { wrapper, client } = queryWrapper();
    const hook = renderHook(
      () =>
        useVaultSetting<string>({
          fs: vault.fs,
          markdown: remarkMarkdown,
          parse,
          store: vault.store,
          vaultKey: 'a',
          activity: recordingActivity(),
        }),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.value).toBe('before'));

    act(() => hook.result.current.save('after'));
    // Another setting's change reads the note again before this write lands.
    await act(() => client.invalidateQueries());
    expect(hook.result.current.value).toBe('after');

    await act(async () => vault.land());
    await waitFor(() => expect(vault.file.value).toBe('after'));
    expect(hook.result.current.value).toBe('after');
  });

  it('puts back what the file holds once a write that failed has landed', async () => {
    const fs = vaultSaying('kept');
    const { hook } = renderSetting({ fs, vaultKey: 'a' }, 'The settings note is locked.');
    await waitFor(() => expect(hook.result.current.value).toBe('kept'));

    act(() => hook.result.current.save('lost'));
    expect(hook.result.current.value).toBe('lost');

    await waitFor(() => expect(hook.result.current.value).toBe('kept'));
    expect(hook.result.current.problem).toBe('The settings note is locked.');
  });

  it('shows an edit made in another program once the note is read again', async () => {
    const file = { value: 'first' };
    const fs = fakeVaultFs({
      readNotes: async () => [{ path: SETTINGS, text: noteOf(file.value), modified: 1, size: 1 }],
    });
    const { hook, client } = renderSetting({ fs, vaultKey: 'a' });
    await waitFor(() => expect(hook.result.current.value).toBe('first'));

    file.value = 'second';
    await act(() => client.invalidateQueries());

    await waitFor(() => expect(hook.result.current.value).toBe('second'));
  });
});

describe('two settings writing at once, over the one read of the note', () => {
  it('shows each its own value, and neither takes the other’s landing for its own', async () => {
    const file: Record<string, string> = { a: 'a0', b: 'b0' };
    const fs = fakeVaultFs({
      readNotes: async () => [
        { path: SETTINGS, text: `---\na: ${file.a}\nb: ${file.b}\n---\n`, modified: 1, size: 1 },
      ],
    });
    const landing = new Map<string, () => void>();
    const storeOf = (key: 'a' | 'b') => (next: string) =>
      new Promise<void>((resolve) =>
        landing.set(key, () => {
          file[key] = next;
          resolve();
        }),
      );
    const parseOf = (key: 'a' | 'b') => (settings: Readonly<Record<string, unknown>>) =>
      typeof settings[key] === 'string' ? (settings[key] as string) : null;
    const [parseA, parseB, storeA, storeB] = [
      parseOf('a'),
      parseOf('b'),
      storeOf('a'),
      storeOf('b'),
    ];
    const { wrapper } = queryWrapper();
    const activity = recordingActivity();
    const hook = renderHook(
      () => ({
        a: useVaultSetting<string>({
          fs,
          markdown: remarkMarkdown,
          parse: parseA,
          store: storeA,
          vaultKey: 'v',
          activity,
        }),
        b: useVaultSetting<string>({
          fs,
          markdown: remarkMarkdown,
          parse: parseB,
          store: storeB,
          vaultKey: 'v',
          activity,
        }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.b.value).toBe('b0'));

    act(() => {
      hook.result.current.a.save('a1');
      hook.result.current.b.save('b1');
    });
    // A lands first: the note is read again, holding A's new value and B's old one.
    await act(async () => landing.get('a')?.());
    await waitFor(() => expect(file.a).toBe('a1'));
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    expect(hook.result.current.a.value).toBe('a1');
    // B's write is still out: what the note held before it is set aside, not shown.
    expect(hook.result.current.b.value).toBe('b1');

    await act(async () => landing.get('b')?.());
    await waitFor(() => expect(file.b).toBe('b1'));
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    expect(hook.result.current.a.value).toBe('a1');
    expect(hook.result.current.b.value).toBe('b1');
  });
});

describe('useVaultSetting and the Activity log', () => {
  it('records a save it gives up on, once', async () => {
    const { hook, activity } = renderSetting(
      { fs: vaultSaying('from A'), vaultKey: 'a' },
      'The settings note is locked.',
    );
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    act(() => hook.result.current.save('changed'));
    await waitFor(() => expect(hook.result.current.problem).toBe('The settings note is locked.'));
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save a setting. The settings note is locked.',
        subject: null,
      },
    ]);
  });

  it('records nothing for a save that lands', async () => {
    const { hook, stored, activity } = renderSetting({ fs: vaultSaying('from A'), vaultKey: 'a' });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    act(() => hook.result.current.save('changed'));
    await waitFor(() => expect(stored).toHaveLength(1));
    expect(hook.result.current.problem).toBeNull();
    expect(activity.reports).toEqual([]);
  });
});
