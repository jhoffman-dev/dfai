// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type EditorDocument, type VaultPath } from '@dfai/domain';
import type { VaultFsPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useNote } from './use-note.ts';

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

/** One note on disk, whose writes the test holds until it lets them go; any other path does not exist. */
function heldWritesVault() {
  const file = { text: ORIGINAL, modified: 1 };
  let open = true;
  let waiting: (() => void)[] = [];
  const fs = {
    readTextFile: async (path: VaultPath) => {
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
    hold: () => {
      open = false;
    },
    release: () => {
      open = true;
      const queued = waiting;
      waiting = [];
      for (const resolve of queued) resolve();
    },
  };
}

describe('a pane back on a note before the write it made on the way out has landed (#727)', () => {
  it(
    'saves its next edit without the host refusing the bytes the pane itself wrote',
    async () => {
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
      expect(view.result.current.state).toMatchObject({ kind: 'ready', doc: docOf('Typed before leaving.\n') });

      act(() => view.result.current.changeDoc(docOf('Typed before leaving.\n\nAnd more.\n')));
      act(() => view.result.current.save());
      await settle();

      expect(view.result.current.state).toMatchObject({ kind: 'ready', saveError: null });
      expect(vault.contents()).toContain('And more.');
    },
  );
});
