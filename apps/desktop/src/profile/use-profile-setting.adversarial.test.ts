// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, type VaultFsPort, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { chatSystemPrompt, type ProfileState } from '@dfai/domain';
import { useProfileSetting } from './use-profile-setting.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

/* Adversarial pass on #10 / #1: the profile as the app hands it to the chat and to Settings. */

const SETTINGS = '.atlas/settings.md';
const NAMED = '---\nprofileName: Ada Lovelace\nprofilePreferredName: Ada\n---\n';

/** A vault whose settings note lives in memory, written as the host writes it. */
function vaultWithSettings(text: string) {
  const file = { text, modified: 1 };
  const fs = fakeVaultFs({
    readNotes: async () => [{ path: SETTINGS, text: file.text, modified: file.modified, size: 1 }],
    readTextFile: async () => ({ text: file.text, modified: file.modified }),
    writeTextFile: async ({ contents }) => {
      await Promise.resolve();
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  });
  return { fs, file };
}

/** A vault whose settings note has not been read yet, and will not be until `release`. */
function slowVault(text: string) {
  let release = () => {};
  const read = new Promise<void>((resolve) => (release = resolve));
  const fs = fakeVaultFs({
    readNotes: async () => {
      await read;
      return [{ path: SETTINGS, text, modified: 1, size: 1 }];
    },
  });
  return { fs, release };
}

function renderProfile(initial: { fs: VaultFsPort; vaultKey: string }) {
  return renderHook(
    (props: { fs: VaultFsPort; vaultKey: string }) =>
      useProfileSetting({ ...props, markdown: remarkMarkdown, activity: ACTIVITY }),
    { wrapper: queryWrapper().wrapper, initialProps: initial },
  );
}

/** The system prompt the chat builds from the profile the app hands it (app.tsx: `profile: profileSetting.profile`). */
const promptFor = (profile: ProfileState) =>
  chatSystemPrompt({ today: '2026-10-04', context: null, profile });

const nameOf = (profile: ProfileState) => (profile === 'unknown' ? profile : profile.name);

describe('the profile the chat is handed, before and between reads', () => {
  it('a question asked before the settings note is read is not told the person has no name', async () => {
    const { fs, release } = slowVault(NAMED);
    const hook = renderProfile({ fs, vaultKey: 'v' });
    expect(hook.result.current.loaded).toBe(false);

    // The app hands this profile to the chat whether or not it has been read.
    const prompt = promptFor(hook.result.current.profile);
    expect(prompt).not.toContain('has not told DFAI their name');

    release();
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  });

  it("after switching vaults, the previous vault's name is not handed out while the new one is read", async () => {
    const first = vaultWithSettings(NAMED);
    const hook = renderProfile({ fs: first.fs, vaultKey: 'a' });
    await waitFor(() => expect(nameOf(hook.result.current.profile)).toBe('Ada Lovelace'));

    const second = slowVault('---\nprofileName: Grace Hopper\n---\n');
    hook.rerender({ fs: second.fs, vaultKey: 'b' });

    expect(hook.result.current.loaded).toBe(false);
    expect(nameOf(hook.result.current.profile)).not.toBe('Ada Lovelace');
    second.release();
    await waitFor(() => expect(nameOf(hook.result.current.profile)).toBe('Grace Hopper'));
  });

  it("a vault whose settings cannot be read does not inherit the previous vault's name", async () => {
    const first = vaultWithSettings(NAMED);
    const hook = renderProfile({ fs: first.fs, vaultKey: 'a' });
    await waitFor(() => expect(nameOf(hook.result.current.profile)).toBe('Ada Lovelace'));

    const broken = vaultWithSettings('---\nprofileName: A\nprofileName: B\n---\n');
    hook.rerender({ fs: broken.fs, vaultKey: 'b' });
    await waitFor(() => expect(hook.result.current.problem).toContain(SETTINGS));

    // Unknown, not "no name": the chat is told to ask rather than write a placeholder.
    expect(hook.result.current.profile).toBe('unknown');
  });
});

describe('Settings → Profile, saving one field', () => {
  // ProfileSettingsCard saves the one field the person committed.
  const savePreferred = (hook: ReturnType<typeof renderProfile>, preferredName: string) =>
    act(() => hook.result.current.save({ preferredName }));

  it('setting the preferred name leaves a hand-written profileName that is not text alone', async () => {
    const start = '---\nprofileName:\n  - Ada\n  - Lovelace\n---\n';
    const { fs, file } = vaultWithSettings(start);
    const hook = renderProfile({ fs, vaultKey: 'v' });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    savePreferred(hook, 'Ada');
    await waitFor(() => expect(file.modified).toBe(2));

    expect(file.text).toContain('profileName:\n  - Ada\n  - Lovelace\n');
  });

  it('setting the preferred name does not cut a hand-written full name longer than the limit', async () => {
    const long = `Ada ${'Augusta '.repeat(14)}Lovelace`; // 120 characters
    const { fs, file } = vaultWithSettings(`---\nprofileName: ${long}\n---\n`);
    const hook = renderProfile({ fs, vaultKey: 'v' });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    savePreferred(hook, 'Ada');
    await waitFor(() => expect(file.modified).toBe(2));

    expect(file.text).toContain(`profileName: ${long}\n`);
  });

  it('a field committed before the note is read does not erase the name it holds', async () => {
    const file = { text: NAMED, modified: 1 };
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const fs = fakeVaultFs({
      readNotes: async () => {
        reads += 1;
        // The first read (the hook's load) is slow; the writer's own reads are not.
        if (reads === 1) await gate;
        return [{ path: SETTINGS, text: file.text, modified: file.modified, size: 1 }];
      },
      readTextFile: async () => ({ text: file.text, modified: file.modified }),
      writeTextFile: async ({ contents }) => {
        file.text = contents;
        file.modified += 1;
        return file.modified;
      },
    });
    const hook = renderProfile({ fs, vaultKey: 'v' });
    expect(hook.result.current.loaded).toBe(false);

    // The card is on screen with empty fields; the person fills in "Preferred name" —
    // with a name the note does not hold yet, so the write has to land before the load.
    savePreferred(hook, 'Countess');
    await waitFor(() => expect(file.modified).toBe(2));
    release();

    expect(file.text).toContain('profilePreferredName: Countess');
    expect(file.text).toContain('profileName: Ada Lovelace');
  });
});
