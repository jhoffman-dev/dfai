// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { fakeVaultFs } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useCreateNote, type CaptureOutcome } from './use-create-note.ts';

/**
 * Quick capture (#672): what the palette is told when a capture cannot be
 * written — a full disk, no connection on the web — so it can keep the text
 * and say why, rather than clear the field and lose it.
 */
function hook(fs: ReturnType<typeof fakeVaultFs>) {
  const onCreated = vi.fn();
  const { result } = renderHook(() =>
    useCreateNote({
      fs,
      markdown: remarkMarkdown,
      notePaths: [],
      beside: () => null,
      templates: [],
      contentsOf: async () => '',
      onCreated,
    }),
  );
  return { result, onCreated };
}

describe('useCreateNote captureNote', () => {
  it('clears a notice from before once a capture is written', async () => {
    let refuse = true;
    const fs = fakeVaultFs({
      createNote: async () => {
        if (refuse) throw new Error('The disk is full.');
        return 0;
      },
    });
    const { result } = hook(fs);
    await act(async () => {
      await result.current.createNewNote();
    });
    expect(result.current.error).toBe('The disk is full.');
    refuse = false;
    await act(async () => {
      await result.current.captureNote('Call Tobias Fenn', null);
    });
    expect(result.current.error).toBeNull();
  });

  it('answers the path once the note is written, and opens it', async () => {
    const fs = fakeVaultFs({ createNote: async () => 0 });
    const { result, onCreated } = hook(fs);
    const outcome = await result.current.captureNote('Call Tobias Fenn', null);
    expect(outcome).toEqual({ captured: true, path: 'Inbox/Call Tobias Fenn.md' });
    expect(onCreated).toHaveBeenCalledWith('Inbox/Call Tobias Fenn.md');
  });

  it('answers the reason when the write is refused, and opens nothing', async () => {
    const fs = fakeVaultFs({
      createNote: async () => {
        throw new Error(
          'Saving needs a connection; your edit stays here until you are back online',
        );
      },
    });
    const { result, onCreated } = hook(fs);
    let outcome: CaptureOutcome | null = null;
    // Inside act, so a state the hook set on the way is drawn before it is read.
    await act(async () => {
      outcome = await result.current.captureNote('Call Tobias Fenn', null);
    });
    expect(outcome).toEqual({
      captured: false,
      reason: 'Saving needs a connection; your edit stays here until you are back online',
    });
    expect(onCreated).not.toHaveBeenCalled();
    // The palette says it, beside the text it kept: not the window's notices as well.
    expect(result.current.error).toBeNull();
  });
});
