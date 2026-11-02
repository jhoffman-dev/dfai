// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, WEB_DEVICE, type VaultPath } from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useNote, type NotePorts } from './use-note.ts';

/*
 * #665: a save refused because the note moved on has a way out that loses
 * neither version — keep mine as a conflict copy beside the newer note.
 */
const NOTE = createVaultPath('Plan.md');
const COPY = 'Plan (conflict from DFAI web).md';

function vault() {
  const files = new Map<string, { text: string; modified: number }>([
    [NOTE, { text: '# Plan\n\nFirst.\n', modified: 1 }],
  ]);
  let refuseCreate = false;
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`no ${path}`);
      return { ...file };
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      const file = files.get(path)!;
      if (file.modified !== expectedModified)
        throw new VaultAccessError('the note changed on disk since it was opened');
      files.set(path, { text: contents, modified: file.modified + 1 });
      return file.modified + 1;
    },
    createNote: async ({ path, contents }) => {
      if (refuseCreate || files.has(path)) throw new VaultAccessError(`${path} is taken`);
      files.set(path, { text: contents, modified: 1 });
      return 1;
    },
  });
  return {
    fs,
    text: (path: string) => files.get(path)?.text,
    writeOutside: (text: string) => files.set(NOTE, { text, modified: 9 }),
    refuseCreate: () => void (refuseCreate = true),
  };
}

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function refusedPane(held: ReturnType<typeof vault>, device: string | undefined) {
  const ports: NotePorts = {
    fs: held.fs,
    markdown: remarkMarkdown,
    ...(device !== undefined && { device }),
  };
  const view = renderHook(() => useNote({ ports, vault: '/vault', path: NOTE as VaultPath }));
  await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
  act(() => view.result.current.changeDoc(remarkMarkdown.parseBody('# Plan\n\nMine.\n').doc));
  held.writeOutside('# Plan\n\nTheirs.\n');
  act(() => view.result.current.save());
  await settle();
  const { state } = view.result.current;
  expect(state.kind === 'ready' && state.saveError).toBeTruthy();
  return view;
}

describe('keeping a refused save as a conflict copy (#665)', () => {
  it('keeps mine whole beside the note, then shows the newer note with nothing unsaved', async () => {
    const held = vault();
    const view = await refusedPane(held, WEB_DEVICE);

    act(() => view.result.current.keepAsCopy?.());
    await settle();
    await settle();

    expect(held.text(COPY)).toBe('# Plan\n\nMine.\n');
    expect(held.text(NOTE)).toBe('# Plan\n\nTheirs.\n');
    expect(view.result.current.dirty).toBe(false);
    const { state } = view.result.current;
    expect(state.kind === 'ready' && state.saveError).toBeNull();
    expect(view.result.current.open?.originalBody).toContain('Theirs.');
  });

  it('keeps the edits on screen, with the reason, when the copy cannot be written', async () => {
    const held = vault();
    const view = await refusedPane(held, WEB_DEVICE);
    held.refuseCreate();

    act(() => view.result.current.keepAsCopy?.());
    await settle();

    expect(held.text(COPY)).toBeUndefined();
    expect(view.result.current.dirty).toBe(true);
    const { state } = view.result.current;
    expect(state.kind === 'ready' && state.saveError).toMatch(/taken/);
  });

  it('is not offered where no device is named to name the copy for', async () => {
    const view = await refusedPane(vault(), undefined);
    expect(view.result.current.keepAsCopy).toBeNull();
  });
});
