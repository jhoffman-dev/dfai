// @vitest-environment jsdom
/**
 * The vault's settings note is read once for every setting it holds, and not
 * again for a change that is not to it (#293): an autosave or a tick moves
 * the index, and used to read the note again once for each setting shown.
 * Driven as the window drives it, through its reads (`createReadInvalidator`).
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, readsTouchedByPaths, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { useProfileSetting } from '../profile/use-profile-setting.ts';
import { useSidebarOrder } from '../sidebar/use-sidebar-order.ts';
import { useQuickAddSetting } from '../quick-add/use-quick-add-setting.ts';

const SETTINGS = '.atlas/settings.md';
const ACTIVITY = recordingActivity();

function countingVault() {
  const file = {
    text: '---\nprofileName: Mara Quill\nquickAdd: [task]\nsidebarOrder: [views, types]\n---\n',
  };
  const asked: string[][] = [];
  const fs = fakeVaultFs({
    readNotes: async (paths) => {
      asked.push([...paths]);
      return paths.includes(SETTINGS)
        ? [{ path: SETTINGS, text: file.text, modified: 1, size: file.text.length }]
        : [];
    },
  });
  const settingsReads = () => asked.filter((paths) => paths.includes(SETTINGS)).length;
  return { fs, file, settingsReads };
}

function renderSettings(fs: ReturnType<typeof countingVault>['fs']) {
  const { wrapper, client } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const hook = renderHook(
    () => {
      const shared = { fs, markdown: remarkMarkdown, vaultKey: 'v', activity: ACTIVITY };
      return {
        profile: useProfileSetting(shared),
        order: useSidebarOrder(shared),
        quickAdd: useQuickAddSetting(shared),
      };
    },
    { wrapper },
  );
  return { hook, reads };
}

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
};

describe('the settings note, read once', () => {
  it('is read once for every setting the window shows', async () => {
    const { fs, settingsReads } = countingVault();
    const { hook } = renderSettings(fs);
    await waitFor(() => expect(hook.result.current.quickAdd.configured).toEqual(['task']));
    await waitFor(() => expect(hook.result.current.order.order.saved).toEqual(['views', 'types']));
    await settle();

    expect(settingsReads()).toBe(1);
  });

  it('is not read again when the index moves for a note that is not it', async () => {
    const { fs, settingsReads } = countingVault();
    const { hook, reads } = renderSettings(fs);
    await waitFor(() => expect(hook.result.current.quickAdd.configured).toEqual(['task']));
    await settle();
    const before = settingsReads();

    // An autosave: its path, and the index's news once it has taken the note in.
    reads.invalidate('v', readsTouchedByPaths(['Projects/DFAI.md']));
    reads.indexMoved('v');
    await settle();

    expect(settingsReads() - before).toBe(0);
  });

  it('is read once again for an edit to it, and every setting shows the edit', async () => {
    const { fs, file, settingsReads } = countingVault();
    const { hook, reads } = renderSettings(fs);
    await waitFor(() => expect(hook.result.current.quickAdd.configured).toEqual(['task']));
    await settle();
    const before = settingsReads();

    file.text =
      '---\nprofileName: Tobias Fenn\nquickAdd: [project]\nsidebarOrder: [types, views]\n---\n';
    reads.invalidate('v', readsTouchedByPaths([SETTINGS]));

    await waitFor(() => expect(hook.result.current.quickAdd.configured).toEqual(['project']));
    await waitFor(() => expect(hook.result.current.order.order.saved).toEqual(['types', 'views']));
    expect(hook.result.current.profile.profile).toMatchObject({ name: 'Tobias Fenn' });
    await settle();
    expect(settingsReads() - before).toBe(1);
  });
});
