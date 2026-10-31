// @vitest-environment jsdom
/**
 * #213: the Inbox's offer to move Area and Resource notes onto the Project
 * type, through the real markdown writer — read only while the Inbox shows,
 * run only from the preview, and every run said in Activity.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type ArchivePorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useParaMigration } from './use-para-migration.ts';

const FILES: Record<string, string> = {
  '.atlas/types/project.md':
    '---\nname: project\nproperties:\n  status: select\n---\n\n# Project\n',
  'Areas/Garden.md': '---\ntype: area\nowner: "[[Mara Quill]]"\n---\n\nBeds.\n',
  'Manual.md': '---\ntype: resource\n---\n',
};

function setup({
  open = true,
  editorState = 'closed',
  failRead = false,
}: { open?: boolean; editorState?: string; failRead?: boolean } = {}) {
  const memory = memoryVault(FILES);
  const fs = fakeVaultFs({
    ...memory.fs,
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = memory.files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 0, size: text.length }];
      }),
  });
  const index = fakeIndexPort({
    query: async () => {
      if (failRead) throw new Error('index not ready');
      return {
        columns: ['path'],
        rows: [...memory.files.keys()]
          .filter((path) => /^type: (area|resource)$/m.test(memory.files.get(path) ?? ''))
          .map((path) => [path]),
        truncated: false,
      };
    },
  });
  const ports = {
    fs,
    markdown: remarkMarkdown,
    index,
    editors: { state: () => editorState, reload: () => {} },
  } as unknown as ArchivePorts;
  const activity = recordingActivity();
  const onChanged = vi.fn();
  const hook = renderHook(
    (props: { open: boolean }) =>
      useParaMigration({
        ports,
        vaultKey: '/vault',
        indexReady: true,
        open: props.open,
        activity,
        onChanged,
      }),
    { initialProps: { open } },
  );
  return { files: memory.files, hook, activity, onChanged };
}

describe('useParaMigration', () => {
  // Since #130 the preview is read as soon as the index is ready, so the Inbox opens on it.
  it('reads the preview before the Inbox shows, and has it ready as it opens', async () => {
    const { hook } = setup({ open: false });
    await waitFor(() => expect(hook.result.current?.preview?.notes).toHaveLength(2));
    hook.rerender({ open: true });
    expect(hook.result.current?.reading).toBe(false);
  });

  it('moves the notes from the preview, and says so in Activity', async () => {
    const { hook, files, activity, onChanged } = setup();
    await waitFor(() => expect(hook.result.current?.preview?.notes).toHaveLength(2));
    act(() => hook.result.current?.onOpen());
    expect(hook.result.current?.open).toBe(true);
    act(() => hook.result.current?.onRun());
    await waitFor(() =>
      expect(hook.result.current?.result).toBe(
        'Moved 2 notes onto the Project type, with PARA set.',
      ),
    );
    expect(files.get('Areas/Garden.md')).toBe(
      '---\ntype: project\nowner: "[[Mara Quill]]"\npara: area\n---\n\nBeds.\n',
    );
    expect(onChanged).toHaveBeenCalled();
    expect(activity.reports.map((report) => report.message)).toEqual([
      'Moved 2 notes onto the Project type, with PARA set.',
    ]);
    await waitFor(() => expect(hook.result.current?.preview).toBeNull());
    act(() => hook.result.current?.onDismiss());
    expect(hook.result.current).toBeNull();
  });

  it('says in Activity each note it left as it was, and why', async () => {
    const { hook, activity } = setup({ editorState: 'dirty' });
    await waitFor(() => expect(hook.result.current?.preview?.notes).toHaveLength(2));
    act(() => hook.result.current?.onRun());
    await waitFor(() => expect(activity.reports).toHaveLength(3));
    expect(activity.reports[0]?.message).toBe(
      'Moved 0 notes onto the Project type, with PARA set. 2 notes left as they were.',
    );
    expect(activity.reports[1]).toMatchObject({
      level: 'warning',
      subject: { kind: 'note', path: 'Areas/Garden.md' },
    });
  });

  it('puts the offer away for now with Not now, and closes the preview first', async () => {
    const { hook, files } = setup();
    await waitFor(() => expect(hook.result.current?.preview?.notes).toHaveLength(2));
    act(() => hook.result.current?.onOpen());
    act(() => hook.result.current?.onClose());
    expect(hook.result.current?.open).toBe(false);
    expect(hook.result.current?.preview?.notes).toHaveLength(2);
    act(() => hook.result.current?.onClose());
    expect(hook.result.current?.preview).toBeNull();
    expect(files.get('Manual.md')).toBe(FILES['Manual.md']);
  });

  it('says when the notes could not be read', async () => {
    const { hook } = setup({ failRead: true });
    await waitFor(() =>
      expect(hook.result.current?.problem).toBe(
        'Your PARA notes could not be read: index not ready',
      ),
    );
  });
});
