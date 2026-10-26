// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, type NoteFile } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { usePlanZone } from './use-plan-zone.ts';

const VAULT = '/Users/mara/Vault';
const SETTINGS = '.atlas/settings.md';

const note = (text: string): NoteFile => ({ path: SETTINGS, text, modified: 1, size: 1 });

/** A settings read that lands only when `land` is called. */
function slowSettings(text: string | null) {
  let land: () => void = () => undefined;
  const landed = new Promise<void>((resolve) => {
    land = resolve;
  });
  const fs = fakeVaultFs({
    readNotes: async (paths) => {
      await landed;
      return paths.includes(SETTINGS) && text !== null ? [note(text)] : [];
    },
  });
  return { fs, land: () => land() };
}

const render = (fs: ReturnType<typeof fakeVaultFs>, vaultKey: string | null = VAULT) =>
  renderHook(() => usePlanZone({ fs, markdown: remarkMarkdown, vaultKey }), {
    wrapper: queryWrapper().wrapper,
  });

describe('usePlanZone (#587)', () => {
  it('tells a read not landed yet from one that keeps no zone', async () => {
    const { fs, land } = slowSettings('---\ntheme: dark\n---\n');
    const hook = render(fs);
    expect(hook.result.current).toEqual({ read: false, zone: null });
    land();
    await waitFor(() => expect(hook.result.current).toEqual({ read: true, zone: null }));
  });

  it('gives the zone once the read lands', async () => {
    const { fs, land } = slowSettings('---\ngoogle_plan_zone: America/Chicago\n---\n');
    const hook = render(fs);
    expect(hook.result.current.read).toBe(false);
    land();
    await waitFor(() =>
      expect(hook.result.current).toEqual({ read: true, zone: 'America/Chicago' }),
    );
  });

  it('counts a vault with no settings note as read, keeping no zone', async () => {
    const { fs, land } = slowSettings(null);
    land();
    const hook = render(fs);
    await waitFor(() => expect(hook.result.current).toEqual({ read: true, zone: null }));
  });

  it('counts a settings note that cannot be read as read: the Mac’s clock, as before any zone', async () => {
    const { fs, land } = slowSettings('---\n: [unclosed\n---\n');
    land();
    const hook = render(fs);
    await waitFor(() => expect(hook.result.current).toEqual({ read: true, zone: null }));
  });
});
