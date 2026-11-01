// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
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

/** Second attack on PR #729: the pane keeping work it could not hand back (`unkept`). */

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

function pane(
  vault: ReturnType<typeof heldVault>,
  onStranded?: (stranding: Stranding) => void,
  kept = new Map<VaultPath, StrandedEdit>(),
) {
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

const typed = (view: ReturnType<typeof pane>, body: string) => {
  const shown = view.result.current.state;
  return shown.kind === 'ready' && JSON.stringify(shown.doc) === JSON.stringify(docOf(body));
};

/** A keeper that keeps refused work in `kept` except on the calls listed, where it throws. */
function failingKeeper(kept: Map<VaultPath, StrandedEdit>, failOn: number[]) {
  let calls = 0;
  return ({ path: at, doc, reason, modified }: Stranding) => {
    calls += 1;
    if (failOn.includes(calls)) throw new Error('could not keep the work');
    kept.set(at, { path: at, doc, reason, modified, keptAt: 1 });
  };
}

/** Leaves NOTE for OTHER with its write held, has another app write NOTE, lets the refused write go. */
async function leaveAndBeRefused(
  vault: ReturnType<typeof heldVault>,
  view: ReturnType<typeof pane>,
  outside: string,
) {
  vault.hold();
  view.rerender({ path: OTHER });
  await settle();
  vault.writeOutside(outside);
  vault.release();
  await settle();
  await settle();
}

describe('second attack on PR #729: work the pane keeps when the keeper throws', () => {
  it('a later refusal that cannot be kept is not shadowed by earlier work the keeper still holds', async () => {
    const vault = heldVault();
    const kept = new Map<VaultPath, StrandedEdit>();
    // Kept the first time, refused by the keeper the second (a store filling up).
    const keep = failingKeeper(kept, [2]);
    const view = pane(vault, keep, kept);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('First typing.\n')));
    await leaveAndBeRefused(vault, view, '# Note\n\nOutside one.\n');
    expect(kept.has(NOTE)).toBe(true);

    view.rerender({ path: NOTE });
    await settle();
    await settle();
    expect(typed(view, 'First typing.\n')).toBe(true);
    act(() => view.result.current.changeDoc(docOf('First typing.\n\nSecond typing.\n')));
    await leaveAndBeRefused(vault, view, '# Note\n\nOutside two.\n');

    view.rerender({ path: NOTE });
    await settle();
    await settle();
    // The second typing is the newest work and exists nowhere but this pane.
    expect(typed(view, 'First typing.\n\nSecond typing.\n')).toBe(true);
  });

  it('work put back on screen as outdated is not lost when the keeper fails again on the way out', async () => {
    const vault = heldVault();
    const kept = new Map<VaultPath, StrandedEdit>();
    // The keeper is broken for good (storage full): every hand-back throws.
    const keep = failingKeeper(kept, [1, 2, 3, 4]);
    const view = pane(vault, keep, kept);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Only copy.\n')));
    await leaveAndBeRefused(vault, view, '# Note\n\nOutside.\n');

    view.rerender({ path: NOTE });
    await settle();
    await settle();
    // The fix under attack: the pane put the work back, outdated.
    expect(typed(view, 'Only copy.\n')).toBe(true);

    // Leaving again: outdated work takes the `held` branch, which hands it
    // back with no fallback when the keeper throws.
    // The keeper's throw escapes the effect cleanup (and the rerender); caught
    // so the test asserts on where the work went, not on how it was lost.
    try {
      view.rerender({ path: OTHER });
      await settle();
    } catch {
      // Expected under the bug: asserted on below through the work itself.
    }
    view.rerender({ path: NOTE });
    await settle();
    await settle();
    expect(vault.contents()?.includes('Only copy.') || typed(view, 'Only copy.\n')).toBe(true);
  });

  /** Runs `act` while catching what is thrown from microtasks, where the pane reports work it lost. */
  async function thrownFromMicrotasks(during: () => Promise<void>): Promise<unknown[]> {
    const thrown: unknown[] = [];
    const original = globalThis.queueMicrotask;
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) =>
      original(() => {
        try {
          task();
        } catch (cause) {
          thrown.push(cause);
        }
      }),
    );
    try {
      await during();
    } finally {
      spy.mockRestore();
    }
    return thrown;
  }

  it('reports work held in a pane that closes for good, with its path and why, rather than dropping it', async () => {
    const vault = heldVault();
    const kept = new Map<VaultPath, StrandedEdit>();
    const view = pane(vault, failingKeeper(kept, [1, 2, 3, 4]), kept);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Only copy.\n')));
    await leaveAndBeRefused(vault, view, '# Note\n\nOutside.\n');
    expect(kept.size).toBe(0);

    const thrown = await thrownFromMicrotasks(async () => {
      view.unmount();
      await settle();
    });
    expect(thrown).toHaveLength(1);
    expect(String(thrown[0])).toMatch(/note\.md/);
    expect(String(thrown[0])).toMatch(/could not keep the work/);
  });

  it('reports work refused after its pane closed, when the keeper cannot keep it either', async () => {
    const vault = heldVault();
    const kept = new Map<VaultPath, StrandedEdit>();
    const view = pane(vault, failingKeeper(kept, [1, 2, 3, 4]), kept);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Only copy.\n')));
    vault.hold();

    const thrown = await thrownFromMicrotasks(async () => {
      view.unmount();
      await settle();
      vault.writeOutside('# Note\n\nOutside.\n');
      vault.release();
      await settle();
      await settle();
    });
    expect(thrown).toHaveLength(1);
    expect(String(thrown[0])).toMatch(/note\.md/);
  });
});
