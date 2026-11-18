// @vitest-environment jsdom
/**
 * Settings → Features' switch (#901), through the vault's one settings writer:
 * one key's change, the rest of the note byte for byte, and a failed write
 * shown and put back.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useFeaturesSetting } from './use-features-setting.ts';

const SETTINGS = '.atlas/settings.md';
const BODY = '\n# Settings\n\nWords Mara Quill wrote here.\n';
const FRONT = 'sidebarOrder: [views, types]\nkeptAside: as typed   # a comment\n';

/** A settings note on disk, whose next write can be told to fail. */
function diskVault(text = `---\n${FRONT}---${BODY}`) {
  const disk = { text, modified: 1, writes: 0 };
  const refusals: string[] = [];
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes(SETTINGS)
        ? [{ path: SETTINGS, text: disk.text, modified: disk.modified, size: disk.text.length }]
        : [],
    readTextFile: async () => ({ text: disk.text, modified: disk.modified }),
    writeTextFile: async ({ contents }) => {
      const refusal = refusals.shift();
      if (refusal !== undefined) throw new Error(refusal);
      disk.text = contents;
      disk.modified += 1;
      disk.writes += 1;
      return disk.modified;
    },
  });
  return { fs, disk, refusals };
}

function renderSetting(fs: ReturnType<typeof diskVault>['fs']) {
  const { wrapper } = queryWrapper();
  const activity = recordingActivity();
  const hook = renderHook(
    () => useFeaturesSetting({ fs, markdown: remarkMarkdown, vaultKey: 'v', activity }),
    { wrapper },
  );
  return { hook, activity };
}

const settle = async () => {
  for (let turn = 0; turn < 8; turn += 1) await act(async () => {});
};

describe('useFeaturesSetting', () => {
  it('has every feature on in a vault that never switched one off', async () => {
    const { hook } = renderSetting(diskVault().fs);
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(hook.result.current.off).toEqual([]);
  });

  it('switches Reading off with one write of its key, keeping the rest of the note', async () => {
    const vault = diskVault();
    const { hook } = renderSetting(vault.fs);
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    act(() => hook.result.current.switchFeature({ id: 'reading', on: false }));
    expect(hook.result.current.off).toEqual(['reading']);
    await settle();

    expect(vault.disk.writes).toBe(1);
    expect(vault.disk.text).toContain('featuresOff:');
    expect(vault.disk.text).toContain('- reading');
    expect(vault.disk.text).toContain(FRONT);
    expect(vault.disk.text.endsWith(`---${BODY}`)).toBe(true);
    expect(hook.result.current.off).toEqual(['reading']);
  });

  it('switches it back on, leaving an empty list rather than a guess', async () => {
    const vault = diskVault(`---\n${FRONT}featuresOff: [reading]\n---${BODY}`);
    const { hook } = renderSetting(vault.fs);
    await waitFor(() => expect(hook.result.current.off).toEqual(['reading']));

    act(() => hook.result.current.switchFeature({ id: 'reading', on: true }));
    await settle();

    expect(vault.disk.text).toContain('featuresOff: []');
    expect(vault.disk.text).toContain(FRONT);
    expect(hook.result.current.off).toEqual([]);
  });

  it('says why a switch was not saved, records it, and shows what the file holds', async () => {
    const vault = diskVault();
    vault.refusals.push('The disk is full.');
    const { hook, activity } = renderSetting(vault.fs);
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    act(() => hook.result.current.switchFeature({ id: 'reading', on: false }));
    await settle();

    expect(hook.result.current.problem).toContain('The disk is full.');
    expect(activity.reports.length).toBeGreaterThan(0);
    expect(hook.result.current.off).toEqual([]);
    expect(vault.disk.text).not.toContain('featuresOff');
  });
});
