// @vitest-environment jsdom
/**
 * What the window offers with features switched off (#901): one object while
 * the off list's content is the same — through reads of the settings note
 * that answer the same, and through draws of the window for anything else —
 * so nothing memoised on it is made again, and the runners reading it do not
 * start over.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  entryPointsOffered,
  fakeVaultFs,
  readsTouchedByPaths,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { DESKTOP_CAPABILITIES, type FeaturesOn } from '@dfai/domain';
import { SETTINGS_SECTIONS } from '@dfai/ui';
import type { Overlay } from '../overlay.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { createStore } from 'zustand';
import { offeredFor } from './offered-for.ts';
import { paletteCommandsOffered, useFeatureOffWiring, useFeatures } from './use-features.ts';

const preloaded = vi.hoisted(() => [] as FeaturesOn[]);
vi.mock('../pages-on-first-use.ts', () => ({
  preloadFeatures: (on: FeaturesOn) => {
    preloaded.push(on);
    return Promise.resolve();
  },
}));

const SETTINGS = '.atlas/settings.md';
const platform = entryPointsOffered(DESKTOP_CAPABILITIES);

function noteVault(text: string) {
  const file = { text };
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes(SETTINGS)
        ? [{ path: SETTINGS, text: file.text, modified: 1, size: file.text.length }]
        : [],
  });
  return { fs, file };
}

function renderFeatures(fs: ReturnType<typeof noteVault>['fs']) {
  const { wrapper, client } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const activity = recordingActivity();
  const hook = renderHook(
    ({ tick }: { tick: number }) => ({
      tick,
      ...useFeatures({ platform, fs, markdown: remarkMarkdown, vaultKey: 'v', activity }),
    }),
    { wrapper, initialProps: { tick: 0 } },
  );
  return { hook, reads };
}

const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => {});
};

describe('useFeatures', () => {
  it("offers the platform's own object while every feature is on", async () => {
    const { hook } = renderFeatures(noteVault('---\nquickAdd: [task]\n---\n').fs);
    await waitFor(() => expect(hook.result.current.setting.loaded).toBe(true));
    expect(hook.result.current.offered).toBe(platform);
  });

  it('keeps one object through unrelated draws and reads that say the same', async () => {
    const vault = noteVault('---\nfeaturesOff: [reading]\n---\n');
    const { hook, reads } = renderFeatures(vault.fs);
    await waitFor(() => expect(hook.result.current.offered.libraryPages).toBe(false));
    const first = hook.result.current.offered;

    hook.rerender({ tick: 1 });
    expect(hook.result.current.offered).toBe(first);

    // The note read again, its words moved but the same feature off: a new array, the same list.
    vault.file.text = '---\nprofileName: Mara Quill\nfeaturesOff: [reading]\n---\n';
    reads.invalidate('v', readsTouchedByPaths([SETTINGS]));
    await settle();
    expect(hook.result.current.offered).toBe(first);
  });

  it('changes only when the off list does, and back to the very object it was', async () => {
    const vault = noteVault('---\nfeaturesOff: [reading]\n---\n');
    const { hook } = renderFeatures(vault.fs);
    await waitFor(() => expect(hook.result.current.offered.libraryPages).toBe(false));
    const off = hook.result.current.offered;

    act(() => hook.result.current.setting.switchFeature({ id: 'reading', on: true }));
    expect(hook.result.current.offered).toBe(platform);
    act(() => hook.result.current.setting.switchFeature({ id: 'reading', on: false }));
    expect(hook.result.current.offered).toBe(off);
  });

  it("says the vault's settings have answered only once they have, read or not", async () => {
    const { hook } = renderFeatures(noteVault('---\nfeaturesOff: [reading]\n---\n').fs);
    expect(hook.result.current.known.getState()).toBe(false);
    await waitFor(() => expect(hook.result.current.known.getState()).toBe(true));
    const unreadable = fakeVaultFs({ readNotes: () => Promise.reject(new Error('locked')) });
    const failing = renderFeatures(unreadable).hook;
    await waitFor(() => expect(failing.result.current.known.getState()).toBe(true));
    expect(failing.result.current.offered).toBe(platform);
  });

  it("fetches the chunks of the features on once the vault's settings say which", async () => {
    preloaded.length = 0;
    const { hook } = renderFeatures(noteVault('---\nfeaturesOff: [reading]\n---\n').fs);
    await waitFor(() => expect(hook.result.current.setting.loaded).toBe(true));
    await settle();
    expect(preloaded.length).toBeGreaterThan(0);
    expect(preloaded.every((on) => !on.reading)).toBe(true);
  });
});

describe('useFeatureOffWiring', () => {
  function renderWiring() {
    const shown: Overlay[] = [];
    const hidden: Overlay[] = [];
    const showOverlay = (overlay: Overlay) => void shown.push(overlay);
    const hideOverlay = (overlay: Overlay) => void hidden.push(overlay);
    const known = createStore<boolean>()(() => false);
    const hook = renderHook(
      ({ overlay, offered }: { overlay: Overlay | null; offered: typeof platform }) =>
        useFeatureOffWiring({ offered, platform, known, overlay, showOverlay, hideOverlay }),
      { initialProps: { overlay: null as Overlay | null, offered: platform } },
    );
    return { hook, shown, hidden };
  }

  it('closes Add PDF… or Add EPUB… once adding documents stops being offered', () => {
    const readingOff = offeredFor(platform, ['reading']);
    for (const overlay of ['add-pdf', 'add-epub'] as const) {
      const { hook, hidden } = renderWiring();
      hook.rerender({ overlay, offered: platform });
      expect(hidden).toEqual([]);
      hook.rerender({ overlay, offered: readingOff });
      expect(hidden).toEqual([overlay]);
    }
  });

  it('leaves an overlay no switch hides open, whatever is off', () => {
    const { hook, hidden } = renderWiring();
    hook.rerender({ overlay: 'settings', offered: offeredFor(platform, ['reading']) });
    hook.rerender({ overlay: 'search', offered: offeredFor(platform, ['reading']) });
    expect(hidden).toEqual([]);
  });

  it('hands the tabs one object while what is offered is the same', () => {
    const { hook } = renderWiring();
    const first = hook.result.current.wiring;
    hook.rerender({ overlay: 'search', offered: platform });
    expect(hook.result.current.wiring).toBe(first);
    expect(hook.result.current.wiring.offered).toBe(platform);
  });

  it('opens Settings at Features from the notice, and forgets it once Settings closes', () => {
    const { hook, shown } = renderWiring();
    expect(hook.result.current.settingsAt).toBeNull();

    act(() => hook.result.current.wiring.onTurnOn());
    expect(shown).toEqual(['settings']);
    hook.rerender({ overlay: 'settings', offered: platform });
    expect(hook.result.current.settingsAt).toBe(SETTINGS_SECTIONS.features);

    hook.rerender({ overlay: null, offered: platform });
    expect(hook.result.current.settingsAt).toBeNull();
  });
});

describe('paletteCommandsOffered', () => {
  const COMMANDS = [
    { id: 'new-query', label: 'New query' },
    { id: 'add-pdf', label: 'Add PDF…', entry: 'addDocuments' },
    { id: 'open-library', label: 'Library', entry: 'libraryPages' },
  ] as const;

  it('offers every command while its entry point is', () => {
    expect(paletteCommandsOffered(COMMANDS, platform)).toEqual(COMMANDS);
  });

  it('leaves out a command whose entry point is not offered, and keeps one with none', () => {
    const offered = { ...platform, addDocuments: false };
    expect(paletteCommandsOffered(COMMANDS, offered).map((command) => command.id)).toEqual([
      'new-query',
      'open-library',
    ]);
  });
});
