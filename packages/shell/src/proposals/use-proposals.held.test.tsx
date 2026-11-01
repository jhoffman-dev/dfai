// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { recordingActivity, type ProposalPorts } from '@dfai/application';
import { createProposalWrites } from './proposal-writes.ts';
import { inMemoryProposalVault, windowToasts } from './proposals.test-support.ts';
import { useProposals } from './use-proposals.ts';

/*
 * The Proposals' answers in flight are the window's per vault (tab-model.md,
 * PR B): two Inbox tabs' sections on one hold share the answer queue, the
 * answered set and the last answer's undo.
 */

const proposal = (title: string) => `---
type: proposal
kind: task
source: "[[2026-10-01 Standup#^t0003]]"
payload:
  title: ${title}
  properties:
    meeting: "[[2026-10-01 Standup]]"
---
`;
const FIRST = 'Inbox/Proposals/Send the file.md';
const SECOND = 'Inbox/Proposals/Call Tobias.md';
const noClosing = { beforeClose: async () => () => {} };

/** Two sections on one hold, over a vault whose task-making waits until `release`, in the order asked. */
function twoSections() {
  const setup = inMemoryProposalVault({
    [FIRST]: proposal('Send the file'),
    [SECOND]: proposal('Call Tobias'),
  });
  let release = () => {};
  const gate = new Promise<void>((open) => (release = open));
  const began: string[] = [];
  const ports: ProposalPorts = {
    ...setup.ports,
    fs: {
      ...setup.ports.fs,
      createNote: async (note) => {
        began.push(note.path);
        await gate;
        return setup.ports.fs.createNote(note);
      },
    },
  };
  const held = createProposalWrites();
  // One window, so one set of toasts, whichever section answers.
  const shown = windowToasts();
  const mount = (own?: ReturnType<typeof createProposalWrites>) =>
    renderHook(() =>
      useProposals({
        ports,
        clock: { today: () => '2026-10-08' },
        indexKey: 'v1',
        onSettled: vi.fn(),
        activity: recordingActivity(),
        closing: noClosing,
        toasts: shown.toasts,
        onOpen: vi.fn(),
        ...(own !== undefined && { held: own }),
      }),
    );
  return { files: setup.files, release, began, held, mount, said: shown.said };
}

const openPaths = (hook: { result: { current: ReturnType<typeof useProposals> } }) =>
  hook.result.current.section.contents?.open.map((each) => each.path) ?? null;

describe('useProposals on a window-held set of answers', () => {
  it('a second section on the same hold sees the proposal answered in the first as gone, and its Undo stays in the window', async () => {
    const { release, held, mount, said } = twoSections();
    const first = mount(held);
    await waitFor(() => expect(openPaths(first)).toHaveLength(2));
    act(() => first.result.current.section.onAccept(createVaultPath(FIRST)));
    expect(openPaths(first)).toEqual([SECOND]);

    // Mounted afresh on the same hold — a tab switched back to, or the other
    // pane's: it knows an answer is being written, so it shows no list yet
    // (#166: a read begun meanwhile may still list the answered one), while a
    // section with its own hold reads at once and offers the answered proposal again.
    const second = mount(held);
    const alone = mount();
    await waitFor(() => expect(openPaths(alone)).toHaveLength(2));
    expect(openPaths(second)).toBeNull();

    release();
    await waitFor(() => expect(openPaths(second)).toEqual([SECOND]));
    await waitFor(() => expect(said()?.message).toMatch(/Accepted/));
    expect(said()?.onUndo).toBeTypeOf('function');
  });

  it('answers given from two sections go one after another through the one queue', async () => {
    const { files, release, began, held, mount } = twoSections();
    const first = mount(held);
    const second = mount(held);
    await waitFor(() => expect(openPaths(first)).toHaveLength(2));
    await waitFor(() => expect(openPaths(second)).toHaveLength(2));

    act(() => first.result.current.section.onAccept(createVaultPath(FIRST)));
    act(() => second.result.current.section.onAccept(createVaultPath(SECOND)));
    // The first task is being made, held; the second waits behind it and has not begun.
    await waitFor(() => expect(began).toHaveLength(1));
    expect(began[0]).toMatch(/Send the file/);

    release();
    await waitFor(() => expect(began).toHaveLength(2));
    expect(began[1]).toMatch(/Call Tobias/);
    await waitFor(() => expect(files.has(FIRST)).toBe(false));
    await waitFor(() => expect(files.has(SECOND)).toBe(false));
  });
});
