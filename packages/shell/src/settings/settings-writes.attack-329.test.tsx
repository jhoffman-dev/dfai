// @vitest-environment jsdom
/**
 * Attack on #293 (PR #329): several settings, one cached read of the note,
 * written one after another through the vault's one settings writer.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, readsTouchedByPaths, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { useSidebarOrder } from '../sidebar/use-sidebar-order.ts';
import { useQuickAddSetting } from '../quick-add/use-quick-add-setting.ts';
import { useProfileSetting } from '../profile/use-profile-setting.ts';

const SETTINGS = '.atlas/settings.md';
const BODY = '\n# Settings\n\nWords Mara Quill wrote here.\n';
const START = `---\nsidebarOrder: [views, types]\nquickAdd: [task]\nprofileName: Mara Quill\nkeptAside: as typed   # a comment\n---${BODY}`;

/** A settings note on disk, whose writes can be told to fail. */
function diskVault() {
  const disk = { text: START, modified: 1 };
  const refusals: string[] = [];
  // While set, the next write's read of the note waits for it: that write is out.
  const gate: { held: Promise<void> | null } = { held: null };
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes(SETTINGS)
        ? [{ path: SETTINGS, text: disk.text, modified: disk.modified, size: disk.text.length }]
        : [],
    readTextFile: async () => {
      const held = gate.held;
      gate.held = null;
      if (held !== null) await held;
      return { text: disk.text, modified: disk.modified };
    },
    writeTextFile: async ({ contents, expectedModified }) => {
      const refusal = refusals.shift();
      if (refusal !== undefined) throw new Error(refusal);
      if (expectedModified !== null && expectedModified !== disk.modified) {
        throw new Error('The note changed on disk.');
      }
      disk.text = contents;
      disk.modified += 1;
      return disk.modified;
    },
  });
  return { fs, disk, refusals, gate };
}

function renderAll(fs: ReturnType<typeof diskVault>['fs']) {
  const { wrapper, client } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const activity = recordingActivity();
  const hook = renderHook(
    () => {
      const shared = { fs, markdown: remarkMarkdown, vaultKey: 'v', activity };
      return {
        order: useSidebarOrder(shared),
        quickAdd: useQuickAddSetting(shared),
        profile: useProfileSetting(shared),
      };
    },
    { wrapper },
  );
  return { hook, reads };
}

const settle = async () => {
  for (let turn = 0; turn < 8; turn += 1) await act(async () => {});
};

describe('two settings changed one after the other (attack-329)', () => {
  it('keeps both on disk, and the rest of the note byte for byte', async () => {
    const vault = diskVault();
    const { hook } = renderAll(vault.fs);
    await waitFor(() => expect(hook.result.current.order.order.onChange).toBeDefined());

    act(() => hook.result.current.order.order.onChange?.(['types', 'views']));
    act(() => hook.result.current.quickAdd.save(['task', 'meeting']));
    await settle();

    expect(vault.disk.text).toContain('[types, views]');
    expect(vault.disk.text).toMatch(/quickAdd:.*meeting/);
    expect(vault.disk.text).toContain('keptAside: as typed   # a comment');
    expect(vault.disk.text.endsWith(BODY)).toBe(true);
    expect(hook.result.current.order.order.saved).toEqual(['types', 'views']);
    expect(hook.result.current.quickAdd.configured).toEqual(['task', 'meeting']);
  });

  it('puts back only the setting whose write was refused', async () => {
    const vault = diskVault();
    const { hook } = renderAll(vault.fs);
    await waitFor(() => expect(hook.result.current.order.order.onChange).toBeDefined());

    let release = () => {};
    vault.gate.held = new Promise((resolve) => (release = resolve));
    vault.refusals.push('The settings note is locked.');
    act(() => hook.result.current.order.order.onChange?.(['types', 'views']));
    // The reorder's write is out (reading the note); the quick-add change queues behind it.
    await act(async () => {});
    act(() => hook.result.current.quickAdd.save(['task', 'meeting']));
    await act(async () => release());
    await settle();

    await waitFor(() => expect(hook.result.current.order.order.saved).toEqual(['views', 'types']));
    expect(hook.result.current.order.problem).toBe('The settings note is locked.');
    expect(hook.result.current.quickAdd.problem).toBeNull();
    expect(hook.result.current.quickAdd.configured).toEqual(['task', 'meeting']);
    expect(vault.disk.text).toMatch(/quickAdd:.*meeting/);
  });

  it('keeps an outside edit that lands while a write is out, and the write', async () => {
    const vault = diskVault();
    const { hook, reads } = renderAll(vault.fs);
    await waitFor(() => expect(hook.result.current.profile.loaded).toBe(true));

    act(() => hook.result.current.order.order.onChange?.(['types', 'views']));
    // Another editor changes the profile before the reorder has landed; the watcher says so.
    vault.disk.text = vault.disk.text.replace(
      'profileName: Mara Quill',
      'profileName: Tobias Fenn',
    );
    vault.disk.modified += 1;
    act(() => reads.invalidate('v', readsTouchedByPaths([SETTINGS])));
    await settle();

    expect(vault.disk.text).toContain('profileName: Tobias Fenn');
    expect(vault.disk.text).toContain('[types, views]');
    await waitFor(() =>
      expect((hook.result.current.profile.profile as { name: string | null }).name).toBe(
        'Tobias Fenn',
      ),
    );
    expect(hook.result.current.order.order.saved).toEqual(['types', 'views']);
  });
});
