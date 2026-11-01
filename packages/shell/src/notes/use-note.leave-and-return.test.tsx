// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  type EditorDocument,
  type StrandedEdit,
  type VaultPath,
} from '@dfai/domain';
import type { VaultFsPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useNote } from './use-note.ts';
import type { Stranding } from './stranded-edits.ts';

/**
 * Issue #727: a pane that leaves a note with unsaved typing and comes
 * back before the write on the way out has landed. That write is the pane's
 * own, but it is not recorded as `landed` and the read of the note on the
 * way back is not held behind it, so the pane shows the text from before it.
 * Present at 2f758327 as well: not a regression of #726.
 */

const NOTE = createVaultPath('note.md');
const OTHER = createVaultPath('other.md');
const THIS_VAULT = '/vault';
const ORIGINAL = '# Note\n\nFirst line.\n';

const docOf = (body: string): EditorDocument => remarkMarkdown.parseBody(body).doc;

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/**
 * One note on disk, whose writes the test holds until it lets them go, and
 * whose reads it can hold and answer newest first; any other path does not exist.
 */
function heldWritesVault() {
  const file = { text: ORIGINAL, modified: 1 };
  let open = true;
  let waiting: (() => void)[] = [];
  let readsOpen = true;
  const heldReads: (() => void)[] = [];
  const fs = {
    readTextFile: async (path: VaultPath) => {
      if (!readsOpen) await new Promise<void>((resolve) => heldReads.push(resolve));
      if (path !== NOTE) throw new Error(`no such file: ${path}`);
      return { text: file.text, modified: file.modified };
    },
    writeTextFile: async ({
      contents,
      expectedModified,
      expectedText,
    }: {
      contents: string;
      expectedModified: number | null;
      expectedText?: string;
    }) => {
      if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
      if (
        (expectedModified !== null && expectedModified !== file.modified) ||
        (expectedText !== undefined && expectedText !== file.text)
      ) {
        throw new Error('the note changed on disk since it was opened');
      }
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  } as unknown as VaultFsPort; // Only the two calls a pane makes of a note; the rest are never reached here.
  return {
    fs,
    contents: () => file.text,
    /** Another app writes the note, so the pane's next write is refused. */
    writeOutside: (text: string) => {
      file.text = text;
      file.modified += 1;
    },
    hold: () => {
      open = false;
    },
    holdReads: () => {
      readsOpen = false;
    },
    /** Answers the newest held read, if any; the test settles between answers. */
    answerNewestRead: () => {
      readsOpen = true;
      const next = heldReads.pop();
      next?.();
      return next !== undefined;
    },
    release: () => {
      open = true;
      const queued = waiting;
      waiting = [];
      for (const resolve of queued) resolve();
    },
  };
}

/** A pane on the held vault that keeps what it could not save and is handed it back, as the app does. */
function paneKeepingStranded(vault: ReturnType<typeof heldWritesVault>) {
  const kept = new Map<VaultPath, StrandedEdit>();
  const view = renderHook(
    ({ path }: { path: VaultPath }) =>
      useNote({
        ports: { fs: vault.fs, markdown: remarkMarkdown },
        vault: THIS_VAULT,
        path,
        onStranded: ({ vault: _vault, ...edit }: Stranding) =>
          void kept.set(edit.path, { ...edit, keptAt: 1 }),
        recoverStranded: (at) => kept.get(at) ?? null,
        settleStranded: ({ path: at }) => void kept.delete(at),
      }),
    { initialProps: { path: NOTE as VaultPath } },
  );
  return Object.assign(view, { kept });
}

describe('a pane back on a note before the write it made on the way out has landed (#727)', () => {
  it('saves its next edit without the host refusing the bytes the pane itself wrote', async () => {
    const vault = heldWritesVault();
    const view = renderHook(
      ({ path }: { path: VaultPath }) =>
        useNote({ ports: { fs: vault.fs, markdown: remarkMarkdown }, vault: THIS_VAULT, path }),
      { initialProps: { path: NOTE as VaultPath } },
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Typed before leaving.\n')));

    vault.hold();
    view.rerender({ path: OTHER });
    await settle();
    view.rerender({ path: NOTE });
    await settle();
    vault.release();
    await settle();
    await settle();
    expect(vault.contents()).toContain('Typed before leaving.');
    // Back on the note, the pane shows the typing it left with, not the text from before it.
    expect(view.result.current.state).toMatchObject({
      kind: 'ready',
      doc: docOf('Typed before leaving.\n'),
    });

    act(() => view.result.current.changeDoc(docOf('Typed before leaving.\n\nAnd more.\n')));
    act(() => view.result.current.save());
    await settle();

    expect(view.result.current.state).toMatchObject({ kind: 'ready', saveError: null });
    expect(vault.contents()).toContain('And more.');
  });

  it('shows a save still landing, not the text from before it, on the way back', async () => {
    const vault = heldWritesVault();
    const view = renderHook(
      ({ path }: { path: VaultPath }) =>
        useNote({ ports: { fs: vault.fs, markdown: remarkMarkdown }, vault: THIS_VAULT, path }),
      { initialProps: { path: NOTE as VaultPath } },
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Saved before leaving.\n')));

    vault.hold();
    act(() => view.result.current.save());
    await settle();
    view.rerender({ path: OTHER });
    await settle();
    view.rerender({ path: NOTE });
    await settle();
    vault.release();
    await settle();
    await settle();

    expect(vault.contents()).toContain('Saved before leaving.');
    expect(view.result.current.state).toMatchObject({
      kind: 'ready',
      saveError: null,
      doc: docOf('Saved before leaving.\n'),
    });
  });

  it('hands back typing whose write on the way out was refused, rather than showing the disk without it', async () => {
    const vault = heldWritesVault();
    const view = paneKeepingStranded(vault);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Typed before leaving.\n')));

    vault.hold();
    view.rerender({ path: OTHER });
    await settle();
    vault.writeOutside('# Note\n\nWritten by another app.\n');
    view.rerender({ path: NOTE });
    // The read on the way back is answered before the one that keeps the refused typing.
    vault.holdReads();
    vault.release();
    await settle();
    while (vault.answerNewestRead()) await settle();
    await settle();

    expect(vault.contents()).toBe('# Note\n\nWritten by another app.\n');
    expect(view.result.current.state).toMatchObject({
      kind: 'ready',
      dirty: true,
      doc: docOf('Typed before leaving.\n'),
    });
  });

  it('shows "Keep mine" landing, not the other writer\'s text, after leaving before it landed', async () => {
    const vault = heldWritesVault();
    const view = paneKeepingStranded(vault);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Mine.\n')));
    vault.writeOutside('# Note\n\nTheirs.\n');
    act(() => view.result.current.save());
    await settle();
    expect(view.result.current.state).toMatchObject({
      kind: 'ready',
      saveError: expect.any(String),
    });

    // "Keep mine" is held on its way to disk while the pane leaves, writing
    // the same typing on the way out, and comes back.
    vault.hold();
    act(() => view.result.current.overwrite());
    await settle();
    view.rerender({ path: OTHER });
    await settle();
    view.rerender({ path: NOTE });
    await settle();
    vault.release();
    await settle();
    await settle();

    expect(vault.contents()).toBe('Mine.\n');
    // The write on the way out starts from "Keep mine" rather than being
    // refused for it and handing the typing back unsaved.
    expect(view.kept.size).toBe(0);
    expect(view.result.current.state).toMatchObject({
      kind: 'ready',
      dirty: false,
      doc: docOf('Mine.\n'),
    });
    act(() => view.result.current.changeDoc(docOf('Mine.\n\nAnd more.\n')));
    act(() => view.result.current.save());
    await settle();
    expect(view.result.current.state).toMatchObject({ kind: 'ready', saveError: null });
    expect(vault.contents()).toBe('Mine.\n\nAnd more.\n');
  });
});
