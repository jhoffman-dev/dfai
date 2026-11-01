// @vitest-environment jsdom
/**
 * Regressions found in PR #534 (#523): a comment typed in place is written by
 * `editHighlightComment`, which replaces the highlight's whole comment with
 * what the field holds. The field was drawn from the note as it was read;
 * when the comment changed on disk since — Kindle sync adding the follow-up
 * note typed on the Kindle, an edit in Obsidian — before the pane read the
 * note again, the write must not throw that newer comment away.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  appendHighlights,
  createVaultPath,
  literatureNoteText,
  readHighlights,
} from '@dfai/domain';
import {
  fakeVaultFs,
  openNote,
  UnsavedTypingError,
  type OpenNote,
  type OpenNotes,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useNoteHighlights } from './use-note-highlights.ts';

const noteBlocks = (text: string) => remarkMarkdown.noteBlocks(text);
const BOOK = createVaultPath('Library/Brightwater.md');

/** A fixed random source: the same ids on every run. */
function drawn(): () => number {
  let at = 0;
  return () => ((at++ * 7 + 3) % 36) / 36;
}

const TEXT = appendHighlights({
  text: literatureNoteText({
    kind: 'kindle',
    title: 'Brightwater',
    author: 'Tobias Fenn',
    asin: 'B0EXAMPLE1',
    file: null,
  }),
  highlights: [
    {
      quote: 'The tide keeps its own hours.',
      anchor: { kind: 'kindle', location: { start: 41, end: 44 }, annotationId: 'A1' },
      comment: 'Lit by Mara.',
    },
  ],
  random: drawn(),
  noteBlocks,
}).text;
const ID = readHighlights(TEXT, noteBlocks)[0]?.id ?? '';

function memoryVault() {
  let clock = 100;
  const files = new Map([[BOOK as string, { text: TEXT, modified: clock }]]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      return { ...file };
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (expectedModified !== null && files.get(path)?.modified !== expectedModified) {
        throw new Error('the note changed on disk since it was opened');
      }
      files.set(path, { text: contents, modified: (clock += 1) });
      return clock;
    },
  });
  const edit = (text: string) => files.set(BOOK, { text, modified: (clock += 1) });
  return { files, fs, edit };
}

let paneState = () => 'clean';
const openNotes = {
  state: () => paneState(),
  setPropertiesIfOpen: async () => false,
  reload: () => {},
} as unknown as OpenNotes;

async function commenting(
  given: {
    flush?: () => Promise<void>;
    state?: () => string;
    toasts?: { show: (toast: unknown) => number };
    kept?: Parameters<typeof useNoteHighlights>[0]['kept'];
  } = {},
) {
  const vault = memoryVault();
  const open: OpenNote = await openNote({ fs: vault.fs, markdown: remarkMarkdown, path: BOOK });
  const hook = renderHook(() =>
    useNoteHighlights({
      fs: vault.fs,
      markdown: remarkMarkdown,
      openNotes,
      flush: given.flush ?? (async () => {}),
      path: BOOK,
      open,
      onChanged: () => {},
      ...(given.toasts !== undefined && { toasts: given.toasts }),
      ...(given.kept !== undefined && { kept: given.kept }),
    }),
  );
  return { vault, hook };
}

describe('a comment written after the note changed on disk', () => {
  it('starts from a note whose highlight has the comment the field shows (the premise)', () => {
    expect(TEXT).toContain('> Lit by Mara.\n');
    expect(ID).not.toBe('');
  });

  it('keeps the follow-up note a Kindle sync added to the comment since the field was drawn', async () => {
    const { vault, hook } = await commenting();
    // The sync lands while the field is open: the pane has not read the note again yet.
    // As the sync writes a typed note (withHighlightCommentAfter): a paragraph after the comment.
    vault.edit(TEXT.replace('> Lit by Mara.\n', '> Lit by Mara.\n>\n> From the Kindle.\n'));
    await act(async () => {
      // A refusal is an answer too: what is asserted is the file.
      await hook.result.current
        ?.editComment({ id: ID, comment: 'Lit by Mara. Typed in DFAI.', base: 'Lit by Mara.' })
        .catch(() => {});
    });
    expect(vault.files.get(BOOK)?.text).toContain('From the Kindle.');
  });

  it('keeps a comment changed in Obsidian since the field was drawn', async () => {
    const { vault, hook } = await commenting();
    vault.edit(TEXT.replace('> Lit by Mara.', '> Lit by Mara, at dusk (Obsidian).'));
    await act(async () => {
      await hook.result.current
        ?.editComment({ id: ID, comment: 'Lit by Mara. Typed in DFAI.', base: 'Lit by Mara.' })
        .catch(() => {});
    });
    expect(vault.files.get(BOOK)?.text).toContain('at dusk (Obsidian)');
  });
});

describe('a comment write, in order (#534)', () => {
  it('writes the pane’s typing first, then reads the note and writes the comment', async () => {
    const order: string[] = [];
    const { vault, hook } = await commenting({
      flush: async () => {
        order.push('flush');
      },
    });
    const read = vault.fs.readTextFile;
    vault.fs.readTextFile = async (path) => {
      order.push('read');
      return read(path);
    };
    await act(async () => {
      await hook.result.current?.editComment({ id: ID, comment: 'Typed.', base: 'Lit by Mara.' });
    });
    expect(order.slice(0, 2)).toEqual(['flush', 'read']);
    expect(vault.files.get(BOOK)?.text).toContain('> Typed.');
  });

  it('refuses, keeping the note as it is, when typing begins between the flush and the write', async () => {
    paneState = () => 'clean';
    const { vault, hook } = await commenting({
      flush: async () => {
        // The person types in the pane as the flush settles.
        paneState = () => 'dirty';
      },
    });
    let refusal: unknown;
    await act(async () => {
      refusal = await hook.result.current
        ?.editComment({ id: ID, comment: 'Typed.', base: 'Lit by Mara.' })
        .catch((error: unknown) => error);
    });
    paneState = () => 'clean';
    expect(refusal).toBeInstanceOf(UnsavedTypingError);
    expect(vault.files.get(BOOK)?.text).toBe(TEXT);
  });

  it('refuses a comment that changed since the field began, naming the one now there', async () => {
    const { vault, hook } = await commenting();
    vault.edit(TEXT.replace('> Lit by Mara.\n', '> Lit by Mara.\n>\n> From the Kindle.\n'));
    let refusal: unknown;
    await act(async () => {
      refusal = await hook.result.current
        ?.editComment({ id: ID, comment: 'Typed.', base: 'Lit by Mara.' })
        .catch((error: unknown) => error);
    });
    expect(refusal).toMatchObject({
      name: 'HighlightCommentChangedError',
      current: 'Lit by Mara.\n\nFrom the Kindle.',
    });
  });

  it('tells, in a toast that stays and offers the words, of a comment that could not be written', async () => {
    const show = vi.fn(() => 1);
    const { hook } = await commenting({ toasts: { show } });
    hook.result.current?.onUnwrittenComments?.([
      {
        id: ID,
        comment: 'Typed, then ⌘W.',
        base: 'Lit by Mara.',
        why: 'The note has unsaved typing.',
      },
    ]);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'error',
        message: expect.stringContaining('Typed, then ⌘W.'),
        action: expect.objectContaining({ label: 'Copy' }),
      }),
    );
  });
});

/*
 * Coordinator decision on PR #534: a comment the closing note could not write
 * goes where its typing would (the stranded-edit store), with its highlight's
 * id and base, and is offered back to the note's fields when it opens again.
 */
describe('a comment the closing note could not write', () => {
  const typed = { id: ID, comment: 'Typed, then ⌘W.', base: 'Lit by Mara.' };
  const keptFor = (offered: readonly (typeof typed)[] = []) => ({
    offered: vi.fn(() => offered),
    keep: vi.fn(),
    settle: vi.fn(),
  });

  it('is kept, with its highlight and the comment it was typed over', async () => {
    const kept = keptFor();
    const { hook } = await commenting({ kept });
    hook.result.current?.onUnwrittenComments?.([{ ...typed, why: 'The disk is full.' }]);
    expect(kept.keep).toHaveBeenCalledWith({
      path: BOOK,
      comments: [typed],
      reason: 'The disk is full.',
    });
  });

  it('is offered back to the note’s fields when it opens again', async () => {
    const kept = keptFor([typed]);
    const { hook } = await commenting({ kept });
    expect(hook.result.current?.recovered).toEqual([typed]);
    expect(kept.offered).toHaveBeenCalledWith(BOOK);
  });

  it('is let go of once the note closes with every comment written', async () => {
    const kept = keptFor([typed]);
    const { hook } = await commenting({ kept });
    hook.result.current?.onUnwrittenComments?.([]);
    expect(kept.settle).toHaveBeenCalledWith({ path: BOOK, comments: [typed] });
    expect(kept.keep).not.toHaveBeenCalled();
  });
});
