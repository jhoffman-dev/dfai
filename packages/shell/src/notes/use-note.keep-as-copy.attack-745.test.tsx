// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  parentVaultPath,
  WEB_DEVICE,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useNote, type NotePorts } from './use-note.ts';
import type { Stranding } from './stranded-edits.ts';

/*
 * Attack on PR #745 (#665): keep-as-copy against typing during the keep, a
 * leaving write, and a note deleted elsewhere. No typed version may be lost.
 */
const NOTE = createVaultPath('Plan.md');
const OTHER = createVaultPath('Other.md');

function vault() {
  const files = new Map<string, { text: string; modified: number }>([
    [NOTE, { text: '# Plan\n\nFirst.\n', modified: 1 }],
    [OTHER, { text: '# Other\n\nUntouched.\n', modified: 1 }],
  ]);
  let refuseCreate = false;
  let holdCreate: Promise<void> | null = null;
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new VaultAccessError('no such entry');
      return { ...file };
    },
    listDirectory: async (folder) =>
      [...files.keys()]
        .filter((path) => parentVaultPath(createVaultPath(path)) === folder)
        .map((path): VaultEntry => ({ kind: 'file', path: createVaultPath(path), name: path })),
    writeTextFile: async ({ path, contents, expectedModified }) => {
      const file = files.get(path);
      if (file === undefined) throw new VaultAccessError('no such entry');
      if (file.modified !== expectedModified)
        throw new VaultAccessError('the note changed on disk since it was opened');
      files.set(path, { text: contents, modified: file.modified + 1 });
      return file.modified + 1;
    },
    createNote: async ({ path, contents }) => {
      await holdCreate;
      if (refuseCreate || files.has(path)) throw new VaultAccessError(`${path} is taken`);
      files.set(path, { text: contents, modified: 1 });
      return 1;
    },
  });
  return {
    fs,
    texts: () => [...files.values()].map((file) => file.text),
    writeOutside: (text: string) => files.set(NOTE, { text, modified: 9 }),
    removeOutside: () => void files.delete(NOTE),
    refuseCreate: () => void (refuseCreate = true),
    holdCopies: () => {
      let release: () => void = () => {};
      holdCreate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        holdCreate = null;
        release();
      };
    },
  };
}

const docOf = (body: string) => remarkMarkdown.parseBody(body).doc;
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function pane(held: ReturnType<typeof vault>, onStranded?: (stranding: Stranding) => void) {
  const ports: NotePorts = { fs: held.fs, markdown: remarkMarkdown, device: WEB_DEVICE };
  return renderHook(
    ({ path }: { path: VaultPath }) =>
      useNote({ ports, vault: '/vault', path, ...(onStranded && { onStranded }) }),
    { initialProps: { path: NOTE } },
  );
}

async function refusedPane(held: ReturnType<typeof vault>, onStranded?: (s: Stranding) => void) {
  const view = pane(held, onStranded);
  await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
  act(() => view.result.current.changeDoc(docOf('# Plan\n\nMine.\n')));
  held.writeOutside('# Plan\n\nTheirs.\n');
  act(() => view.result.current.save());
  await settle();
  const { state } = view.result.current;
  expect(state.kind === 'ready' && state.saveError).toBeTruthy();
  return view;
}

describe('attack #745: keep-as-copy never loses a typed version', () => {
  it('keep, type during the keep, refused again, keep again: both versions are kept', async () => {
    const held = vault();
    const view = await refusedPane(held);
    const release = held.holdCopies();
    act(() => view.result.current.keepAsCopy?.());
    act(() => view.result.current.changeDoc(docOf('# Plan\n\nMine, and more.\n')));
    act(() => view.result.current.save());
    release();
    await settle();
    await settle();
    expect(view.result.current.keepAsCopy).not.toBeNull();
    act(() => view.result.current.keepAsCopy?.());
    await settle();
    await settle();

    expect(held.texts()).toContain('# Plan\n\nMine.\n');
    expect(held.texts()).toContain('# Plan\n\nMine, and more.\n');
    expect(held.texts()).toContain('# Plan\n\nTheirs.\n');
  });

  it('keep that fails while the pane leaves the note: the work is handed back, not lost', async () => {
    const held = vault();
    const stranded: Stranding[] = [];
    const view = await refusedPane(held, (s) => void stranded.push(s));
    held.refuseCreate();
    const release = held.holdCopies();
    act(() => view.result.current.keepAsCopy?.());
    view.rerender({ path: OTHER });
    release();
    await settle();
    await settle();
    await settle();

    expect(held.texts()).not.toContain('# Plan\n\nMine.\n');
    expect(stranded.map((s) => JSON.stringify(s.doc)).join()).toContain('Mine.');
  });

  it('a note deleted elsewhere: the refused typing can still be kept, not only discarded', async () => {
    const held = vault();
    const view = pane(held);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('# Plan\n\nMine.\n')));
    held.removeOutside();
    act(() => view.result.current.save());
    await settle();
    const { state } = view.result.current;
    expect(state.kind === 'ready' && state.saveError).toBeTruthy();

    // Observed: null. "no such entry" is not a stale refusal, so the only
    // ways out are Overwrite — which re-reads the gone note and fails — and
    // Discard, which throws the typing away.
    expect(view.result.current.keepAsCopy).not.toBeNull();
    act(() => view.result.current.keepAsCopy?.());
    await settle();
    await settle();
    expect(held.texts()).toContain('# Plan\n\nMine.\n');
  });
});
