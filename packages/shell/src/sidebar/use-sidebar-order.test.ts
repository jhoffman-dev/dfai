// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useSidebarOrder } from './use-sidebar-order.ts';

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

const SETTINGS = '.atlas/settings.md';

/** A vault holding a settings note, whose writes can be refused. */
function vaultWithSettings({ refuse = false }: { refuse?: boolean } = {}) {
  const file = { text: '---\nquickAdd: [task]\nsidebarOrder: [views, types]\n---\n', modified: 1 };
  const fs = fakeVaultFs({
    readNotes: async () => [{ path: SETTINGS, text: file.text, modified: file.modified, size: 1 }],
    readTextFile: async () => ({ text: file.text, modified: file.modified }),
    writeTextFile: async ({ contents }) => {
      if (refuse) throw new Error('read-only');
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  });
  return { fs, file };
}

const render = (fs: ReturnType<typeof vaultWithSettings>['fs']) =>
  renderHook(
    () =>
      useSidebarOrder({
        fs,
        markdown: remarkMarkdown,
        vaultKey: 'v',
        activity: ACTIVITY,
      }),
    { wrapper: queryWrapper().wrapper },
  );

describe('useSidebarOrder', () => {
  it('reads the order the settings note keeps', async () => {
    const { fs } = vaultWithSettings();
    const hook = render(fs);
    await waitFor(() => expect(hook.result.current.order.saved).toEqual(['views', 'types']));
  });

  it('shows a new order at once and writes it beside the other settings', async () => {
    const { fs, file } = vaultWithSettings();
    const hook = render(fs);
    await waitFor(() => expect(hook.result.current.order.saved).not.toBeNull());

    act(() => hook.result.current.order.onChange?.(['userSpace', 'views']));

    expect(hook.result.current.order.saved).toEqual(['userSpace', 'views']);
    await waitFor(() => expect(file.text).toContain('sidebarOrder: [userSpace, views]'));
    expect(file.text).toContain('quickAdd: [task]');
  });

  it('offers no way to move the sections until the saved order has loaded', async () => {
    const { fs: settled } = vaultWithSettings();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fs = {
      ...settled,
      readNotes: async (paths: Parameters<typeof settled.readNotes>[0]) => {
        await held;
        return settled.readNotes(paths);
      },
    };
    const hook = render(fs);

    // A move made now would be made on the default order, and saved over the chosen one.
    expect(hook.result.current.order.onChange).toBeUndefined();

    release();
    await waitFor(() => expect(hook.result.current.order.saved).toEqual(['views', 'types']));
    expect(hook.result.current.order.onChange).toBeDefined();
  });

  it('names the settings note when it cannot be read, and neither moves nor writes', async () => {
    const { fs, file } = vaultWithSettings();
    const broken = '---\nsidebarOrder: [views]\nsidebarOrder: [types]\n---\n';
    file.text = broken;
    const hook = render(fs);

    await waitFor(() => expect(hook.result.current.unreadable).toContain('.atlas/settings.md'));
    expect(hook.result.current.order.onChange).toBeUndefined();
    expect(file.text).toBe(broken);
  });

  it('says why a change could not be saved', async () => {
    const { fs } = vaultWithSettings({ refuse: true });
    const hook = render(fs);
    await waitFor(() => expect(hook.result.current.order.saved).not.toBeNull());

    act(() => hook.result.current.order.onChange?.(['types']));

    await waitFor(() => expect(hook.result.current.problem).toBe('read-only'));
  });
});
