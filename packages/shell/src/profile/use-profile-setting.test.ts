// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useProfileSetting } from './use-profile-setting.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

const SETTINGS = '.atlas/settings.md';

/** A settings note as a person might have written it by hand, comments and all. */
const HAND_WRITTEN = [
  '---',
  '# my settings, kept tidy by hand',
  'quickAdd: [task, project]   # quick add',
  "sidebarOrder: ['views', 'types']",
  'syncInterval: 5',
  '---',
  '',
  '# Settings',
  '',
  'Words of my own.',
  '',
].join('\n');

/** A vault whose settings note lives in memory, written as the host writes it. */
function vaultWithSettings(text: string) {
  const file = { text, modified: 1 };
  const fs = fakeVaultFs({
    readNotes: async () => [{ path: SETTINGS, text: file.text, modified: file.modified, size: 1 }],
    readTextFile: async () => ({ text: file.text, modified: file.modified }),
    writeTextFile: async ({ contents, expectedModified }) => {
      await Promise.resolve();
      if (expectedModified !== null && expectedModified !== file.modified) {
        throw new Error('The note changed on disk since it was read');
      }
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  });
  return { fs, file };
}

function renderProfile(fs: ReturnType<typeof vaultWithSettings>['fs']) {
  return renderHook(
    () =>
      useProfileSetting({
        fs,
        markdown: remarkMarkdown,
        vaultKey: 'v',
        activity: ACTIVITY,
      }),
    { wrapper: queryWrapper().wrapper },
  );
}

describe('useProfileSetting, through the real markdown adapter', () => {
  it('reads an empty profile from a note that names no one', async () => {
    const { fs } = vaultWithSettings(HAND_WRITTEN);
    const hook = renderProfile(fs);
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(hook.result.current.profile).toEqual({ name: null, preferredName: null });
  });

  it('adds the name and leaves every other byte of the note as it was', async () => {
    const { fs, file } = vaultWithSettings(HAND_WRITTEN);
    const hook = renderProfile(fs);
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    act(() => hook.result.current.save({ name: 'James Hoffman', preferredName: 'James' }));
    await waitFor(() => expect(file.modified).toBe(2));

    // The two keys are added at the end of the frontmatter; nothing else moves.
    expect(file.text).toBe(
      HAND_WRITTEN.replace(
        'syncInterval: 5\n---',
        'syncInterval: 5\nprofileName: James Hoffman\nprofilePreferredName: James\n---',
      ),
    );
    await waitFor(() =>
      expect(hook.result.current.profile).toEqual({
        name: 'James Hoffman',
        preferredName: 'James',
      }),
    );
  });

  it('clearing the name removes its key, so the note is back to what it was', async () => {
    const { fs, file } = vaultWithSettings(HAND_WRITTEN);
    const hook = renderProfile(fs);
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    act(() => hook.result.current.save({ name: 'James Hoffman', preferredName: null }));
    await waitFor(() => expect(file.text).toContain('profileName: James Hoffman'));
    act(() => hook.result.current.save({ name: '', preferredName: null }));
    await waitFor(() => expect(file.text).toBe(HAND_WRITTEN));
  });

  it('says why when the note cannot be read, and reads the name as unknown rather than a stale one', async () => {
    const { fs } = vaultWithSettings('---\nprofileName: A\nprofileName: B\n---\n');
    const hook = renderProfile(fs);
    await waitFor(() => expect(hook.result.current.problem).toContain(SETTINGS));
    expect(hook.result.current.profile).toBe('unknown');
  });
});
