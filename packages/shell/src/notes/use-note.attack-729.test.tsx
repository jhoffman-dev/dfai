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
import { thrownFromMicrotasks } from './testing/thrown-from-microtasks.ts';

/** Attack on PR #729 (fix for issue #727): leaving a note and coming back while its write is out. */

const NOTE = createVaultPath('note.md');
const OTHER = createVaultPath('other.md');
const THIS_VAULT = '/vault';
const ORIGINAL = '# Note\n\nFirst line.\n';

const docOf = (body: string): EditorDocument => remarkMarkdown.parseBody(body).doc;

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Two notes on disk; writes and reads can be held and let go, reads answered newest first. */
function heldVault() {
  const files = new Map<VaultPath, { text: string; modified: number }>([
    [NOTE, { text: ORIGINAL, modified: 1 }],
    [OTHER, { text: '# Other\n', modified: 1 }],
  ]);
  let open = true;
  let waiting: (() => void)[] = [];
  let readsOpen = true;
  const heldReads: (() => void)[] = [];
  const fs = {
    readTextFile: async (path: VaultPath) => {
      if (!readsOpen) await new Promise<void>((resolve) => heldReads.push(resolve));
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      return { text: file.text, modified: file.modified };
    },
    writeTextFile: async ({
      path,
      contents,
      expectedModified,
      expectedText,
    }: {
      path: VaultPath;
      contents: string;
      expectedModified: number | null;
      expectedText?: string;
    }) => {
      if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
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
  } as unknown as VaultFsPort; // Only the two calls a pane makes of a note.
  return {
    fs,
    contents: () => files.get(NOTE)?.text,
    /** Another app writes the note, so the pane's next write of it is refused. */
    writeOutside: (text: string) => {
      const file = files.get(NOTE)!;
      file.text = text;
      file.modified += 1;
    },
    hold: () => {
      open = false;
    },
    holdReads: () => {
      readsOpen = false;
    },
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

function pane(vault: ReturnType<typeof heldVault>, onStranded?: (stranding: Stranding) => void) {
  const kept = new Map<VaultPath, StrandedEdit>();
  const view = renderHook(
    ({ path }: { path: VaultPath }) =>
      useNote({
        ports: { fs: vault.fs, markdown: remarkMarkdown },
        vault: THIS_VAULT,
        path,
        onStranded:
          onStranded ??
          (({ path: at, doc, reason, modified }: Stranding) =>
            void kept.set(at, { path: at, doc, reason, modified, keptAt: 1 })),
        recoverStranded: (at) => kept.get(at) ?? null,
        settleStranded: ({ path: at }) => void kept.delete(at),
      }),
    { initialProps: { path: NOTE as VaultPath } },
  );
  return Object.assign(view, { kept });
}

describe('attack on PR #729: the way back to a note whose write on the way out is still out', () => {
  it('keeps typing whose stranding failed, or says so, rather than showing the disk as saved', async () => {
    const vault = heldVault();
    const view = pane(vault, () => {
      // The keeper of refused work fails (a store or a listener throwing). On
      // main this was an unhandled rejection; under #729 `holdReadsBehind`
      // catches it, and nothing reaches the person.
      throw new Error('could not keep the work');
    });
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Typed before leaving.\n')));

    vault.hold();
    view.rerender({ path: OTHER });
    await settle();
    vault.writeOutside('# Note\n\nWritten by another app.\n');
    view.rerender({ path: NOTE });
    await settle();
    vault.release();
    await settle();
    await settle();

    const shown = view.result.current.state;
    const typingOnScreen =
      shown.kind === 'ready' &&
      JSON.stringify(shown.doc) === JSON.stringify(docOf('Typed before leaving.\n'));
    const errorShown =
      shown.kind === 'failed' || (shown.kind === 'ready' && shown.saveError !== null);
    // The typing is on disk, on screen, or the person is told it is not.
    expect(
      vault.contents()?.includes('Typed before leaving.') || typingOnScreen || errorShown,
    ).toBe(true);
    // Neither on disk nor kept elsewhere, it is back on screen, unsaved, with
    // the choice to overwrite or discard rather than an autosave over the file.
    expect(typingOnScreen && errorShown).toBe(true);
    expect(view.result.current.state).toMatchObject({ kind: 'ready', dirty: true });
    // Closing the pane with the keeper still failing: the work goes with it, loudly.
    const thrown = await thrownFromMicrotasks(async () => {
      view.unmount();
      await settle();
    });
    expect(thrown).toHaveLength(1);
  });

  const ready = (view: ReturnType<typeof pane>) =>
    waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
  const drain = async (vault: ReturnType<typeof heldVault>) => {
    await settle();
    while (vault.answerNewestRead()) await settle();
    await settle();
  };

  it("saves typing made on a round trip quick enough to keep the note on screen, without the host refusing the pane's own bytes", async () => {
    const vault = heldVault();
    const view = pane(vault);
    await ready(view);
    act(() => view.result.current.changeDoc(docOf('First.\n')));
    vault.hold();
    vault.holdReads();
    view.rerender({ path: OTHER });
    await settle();
    // Back before OTHER was read: `loadedNote` is still this note, so the
    // effect treats it as a re-read and keeps the old `note` (modified 1) on
    // screen, editable. The leaving write lands at modified 2, is never
    // recorded as `landed`, and the next save starts from 1 and is refused.
    view.rerender({ path: NOTE });
    await settle();
    expect(view.result.current.state).toMatchObject({ kind: 'ready', doc: docOf('First.\n') });
    act(() => view.result.current.changeDoc(docOf('First.\n\nSecond.\n')));
    vault.release();
    await drain(vault);
    act(() => view.result.current.save());
    await drain(vault);
    expect(view.result.current.state).toMatchObject({ kind: 'ready', saveError: null });
    expect(vault.contents()).toBe('First.\n\nSecond.\n');
  });
});
