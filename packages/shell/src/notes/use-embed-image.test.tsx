// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeVaultFs, recordingActivity } from '@dfai/application';
import { useEmbedImage } from './use-embed-image.ts';

/** An image pasted into a note, and where saving it gives up. */

const NOTE = createVaultPath('Journal/Field trip.md');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A dropped file as the editor hands it over: named, typed, and readable once. */
function droppedFile(name: string, type: string): File {
  return new File([PNG], name, { type });
}

function embedding({ refuse = null }: { refuse?: string | null } = {}) {
  const activity = recordingActivity();
  const fs = fakeVaultFs({
    writeBinaryFile: async ({ bytes, offset }) => {
      if (refuse !== null) throw new Error(refuse);
      return offset + bytes.byteLength;
    },
  });
  const onSaved = vi.fn();
  const hook = renderHook(() =>
    useEmbedImage({
      ports: {
        fs,
        probe: { canShow: async () => true },
        placement: { read: () => 'attachments', write: () => {} },
        now: () => '2026-10-10T09:00:00',
        onSaved,
        activity,
      },
      notePath: NOTE,
    }),
  );
  const embed = hook.result.current;
  if (embed === undefined) throw new Error('a note is open, so images can be embedded');
  return { embed, activity, onSaved };
}

describe('useEmbedImage and the Activity log', () => {
  it('records an image that could not be saved once, naming its note', async () => {
    const { embed, activity } = embedding({ refuse: 'The disk is full.' });
    await expect(embed(droppedFile('trail.png', 'image/png'), 'file')).rejects.toThrow(
      'The disk is full.',
    );
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message:
          'Could not add the image — Field trip. The image could not be saved: The disk is full.',
        subject: { kind: 'note', path: NOTE },
      },
    ]);
  });

  it('records nothing for an image saved', async () => {
    const { embed, activity, onSaved } = embedding();
    await embed(droppedFile('trail.png', 'image/png'), 'file');
    expect(onSaved).toHaveBeenCalled();
    expect(activity.reports).toEqual([]);
  });

  it('records nothing for a file refused as no image it can take', async () => {
    const { embed, activity } = embedding();
    await expect(embed(droppedFile('notes.txt', 'text/plain'), 'file')).rejects.toThrow();
    expect(activity.reports).toEqual([]);
  });
});
