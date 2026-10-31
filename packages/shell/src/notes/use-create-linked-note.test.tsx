// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { fakeMarkdown, fakeVaultFs } from '@dfai/application';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { createNotesBeingMade, type NotesBeingMade } from './notes-being-made.ts';
import { useCreateLinkedNote } from './use-create-linked-note.ts';

/** #465: "Create '<name>'" after `[[` in the editor. Fictional names only. */

const PLANS = createVaultPath('Plans/Offsite.md');

function hook({
  createNote = vi.fn<ReturnType<typeof fakeVaultFs>['createNote']>(async () => 0),
  notePaths = [PLANS],
  beingMade = createNotesBeingMade(),
}: {
  createNote?: ReturnType<typeof fakeVaultFs>['createNote'];
  notePaths?: readonly VaultPath[];
  beingMade?: NotesBeingMade;
} = {}) {
  const onChanged = vi.fn();
  const onProblem = vi.fn();
  const { result, rerender } = renderHook(
    ({ paths }: { paths: readonly VaultPath[] }) =>
      useCreateLinkedNote({
        fs: fakeVaultFs({ createNote }),
        markdown: fakeMarkdown(),
        notePaths: paths,
        beside: PLANS,
        onChanged,
        onProblem,
        beingMade,
      }),
    { initialProps: { paths: notePaths } },
  );
  return { result, rerender, createNote, onChanged, onProblem };
}

describe('useCreateLinkedNote', () => {
  it('makes a blank note beside the note in view, and answers with its link as made', async () => {
    const createNote = vi.fn<ReturnType<typeof fakeVaultFs>['createNote']>(async () => 0);
    const { result, onChanged } = hook({ createNote });
    expect(await result.current.make('Mara Quill')).toBe('Mara Quill');
    expect(JSON.stringify(createNote.mock.calls[0])).toContain('Plans/Mara Quill.md');
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('links the name the file was given, cleaned of what a file name cannot hold', async () => {
    const { result } = hook();
    expect(await result.current.make('Q3: plan')).toBe('Q3 plan');
  });

  it('takes a name any note answers to, an archived one too', () => {
    const { result } = hook({
      notePaths: [PLANS, createVaultPath('Archive/Larkspur.md'), createVaultPath('Q3 plan.md')],
    });
    expect(result.current.named('larkspur')).toBe(true);
    expect(result.current.named('Q3 plan')).toBe(true);
    expect(result.current.named('Tobias Fenn')).toBe(false);
  });

  it('takes a name another pane is making: the window shares what is being made', async () => {
    let finish = () => {};
    const createNote = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(0);
        }),
    );
    const beingMade = createNotesBeingMade();
    const left = hook({ createNote, beingMade });
    const right = hook({ beingMade });
    const made = left.result.current.make('Q3: plan');
    // The right pane asks by the name the file will be given, as the domain's rule does.
    expect(right.result.current.named('Q3 plan')).toBe(true);
    await vi.waitFor(() => expect(createNote).toHaveBeenCalled());
    finish();
    await made;
  });

  it('says so when a note was made but its link could not be written', () => {
    const { result, onProblem } = hook();
    result.current.notLinked?.('Mara Quill');
    expect(onProblem).toHaveBeenCalledWith(
      '“Mara Quill” was made, but the link could not be written here: the note changed meanwhile.',
    );
  });

  it('takes a name being made until the vault lists its note, so a second Create makes no second note', async () => {
    let finish = () => {};
    const createNote = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(0);
        }),
    );
    const { result, rerender } = hook({ createNote });
    const made = result.current.make('Mara Quill');
    expect(result.current.named('Mara Quill')).toBe(true);
    await vi.waitFor(() => expect(createNote).toHaveBeenCalled());
    finish();
    await made;
    // Still taken while the vault's list has not caught up.
    expect(result.current.named('mara quill')).toBe(true);
    rerender({ paths: [PLANS, createVaultPath('Plans/Mara Quill.md')] });
    expect(result.current.named('Mara Quill')).toBe(true);
    rerender({ paths: [PLANS] });
    // Listed once, then gone (deleted): no longer taken.
    expect(result.current.named('Mara Quill')).toBe(false);
  });

  it('says why a note could not be made, passes the refusal on, and frees the name', async () => {
    const { result, onChanged, onProblem } = hook({
      createNote: async () => {
        throw new Error('The disk is full.');
      },
    });
    await expect(result.current.make('Mara Quill')).rejects.toThrow('The disk is full.');
    expect(onProblem).toHaveBeenCalledWith('“Mara Quill” could not be made: The disk is full.');
    expect(onChanged).not.toHaveBeenCalled();
    expect(result.current.named('Mara Quill')).toBe(false);
  });
});
