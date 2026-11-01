// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { correctionDigestOf, createVaultPath } from '@dfai/domain';
import { fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useMeetingCorrections } from './use-meeting-corrections.ts';

const PATH = createVaultPath('Inbox/Meetings/2026-10-06 Standup.md');
const CORRECTED = '## Summary\n\nMara Quill ships it.\n';

/** What the meeting's frontmatter records for one correction made in CORRECTED. */
const PROPERTIES = {
  atlas_corrections: [{ from: 'Mara Quil', to: 'Mara Quill', count: 1, blocks: [], at: [12] }],
  atlas_corrections_digest: correctionDigestOf(CORRECTED),
  atlas_corrections_original_digest: correctionDigestOf('## Summary\n\nMara Quil ships it.\n'),
};

function renderCorrections({
  fileBody,
  flush = async () => {},
}: {
  fileBody: string;
  flush?: () => Promise<void>;
}) {
  const fs = fakeVaultFs({
    readTextFile: async () => ({
      text: `---\ntype: meeting\natlas_corrections_digest: x\n---\n${fileBody}`,
      modified: 1,
    }),
  });
  return renderHook(() =>
    useMeetingCorrections({
      fs,
      markdown: remarkMarkdown,
      openNotes: { state: vi.fn(), reload: vi.fn() } as never,
      flush,
      path: PATH,
      properties: PROPERTIES,
      onChanged: vi.fn(),
      activity: recordingActivity(),
    }),
  );
}

describe('useMeetingCorrections, a refused Undo', () => {
  it('turns Undo off and lets the band be dismissed when the meeting no longer matches its record', async () => {
    const { result } = renderCorrections({ fileBody: 'Someone rewrote this meeting.\n' });
    expect(result.current?.permanent).toBe(false);

    act(() => result.current?.onUndo());
    await waitFor(() => expect(result.current?.refusal).not.toBeNull());
    expect(result.current?.permanent).toBe(true);

    act(() => result.current?.onDismiss());
    expect(result.current).toBeUndefined();
  });

  it('keeps Undo available when the refusal may pass, as unsaved typing may', async () => {
    const { result } = renderCorrections({
      fileBody: CORRECTED,
      flush: async () => {
        throw new Error('The note is open with unsaved typing.');
      },
    });

    act(() => result.current?.onUndo());
    await waitFor(() =>
      expect(result.current?.refusal).toBe('The note is open with unsaved typing.'),
    );
    expect(result.current?.permanent).toBe(false);
  });
});
