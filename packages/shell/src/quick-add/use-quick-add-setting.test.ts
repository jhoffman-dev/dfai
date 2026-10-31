// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useQuickAddSetting } from './use-quick-add-setting.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

const SETTINGS = '.atlas/settings.md';

/** A vault holding a settings note whose host refuses a write against a stale read, as Tauri's does. */
function vaultWithSettings() {
  const file = { text: '---\ntheme: dark\nquickAdd: [task]\n---\n', modified: 1 };
  const fs = fakeVaultFs({
    readNotes: async () => [{ path: SETTINGS, text: file.text, modified: file.modified, size: 1 }],
    readTextFile: async () => ({ text: file.text, modified: file.modified }),
    writeTextFile: async ({ contents, expectedModified }) => {
      // Yield first, as a real write does, so two saves can overlap.
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

describe('useQuickAddSetting, with a settings note that cannot be read', () => {
  it('names the note rather than quietly going back to the default types', async () => {
    const { fs, file } = vaultWithSettings();
    const broken = '---\nquickAdd: [task]\nsidebarOrder: [views]\nsidebarOrder: [types]\n---\n';
    file.text = broken;
    const hook = renderHook(
      () =>
        useQuickAddSetting({
          fs,
          markdown: remarkMarkdown,
          vaultKey: 'v',
          activity: ACTIVITY,
        }),
      { wrapper: queryWrapper().wrapper },
    );

    await waitFor(() => expect(hook.result.current.problem).toContain('.atlas/settings.md'));

    act(() => hook.result.current.save(['idea']));
    await waitFor(() => expect(hook.result.current.problem).toContain('.atlas/settings.md'));
    expect(file.text).toBe(broken);
  });
});

describe('useQuickAddSetting, changed twice in quick succession', () => {
  it('ends with the last choice made written to the vault', async () => {
    const { fs, file } = vaultWithSettings();
    const hook = renderHook(
      () =>
        useQuickAddSetting({
          fs,
          markdown: remarkMarkdown,
          vaultKey: 'v',
          activity: ACTIVITY,
        }),
      { wrapper: queryWrapper().wrapper },
    );
    await waitFor(() => expect(hook.result.current.configured).toEqual(['task']));

    // Two quick reorders: a type added, then moved to the front.
    act(() => {
      hook.result.current.save(['task', 'idea']);
      hook.result.current.save(['idea', 'task']);
    });

    await waitFor(() => expect(file.modified).toBeGreaterThan(1));
    await waitFor(() => expect(file.text).toContain('quickAdd: [idea, task]'));
  });
});
