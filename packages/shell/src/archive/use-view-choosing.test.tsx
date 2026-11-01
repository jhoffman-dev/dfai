// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ArchiveOutcome } from '@dfai/application';
import type { VaultPath } from '@dfai/domain';
import type { ArchiveCommands } from './use-archive.ts';
import { useViewChoosing } from './use-view-choosing.ts';

const settled = (failed: readonly string[] = []): ArchiveOutcome => ({
  moves: [],
  failed: failed.map((path) => ({ path: path as VaultPath, reason: 'locked' })),
  linksUpdated: 0,
});

function setUp() {
  const commands: ArchiveCommands = {
    archive: vi.fn(async () => settled()),
    unarchive: vi.fn(async () => settled()),
    busy: false,
  };
  const hook = renderHook((viewKey: string) => useViewChoosing({ viewKey, commands }), {
    initialProps: '.atlas/views/Tasks.md',
  });
  return { commands, hook };
}

describe('useViewChoosing', () => {
  it('offers to archive the chosen notes in use and unarchive the archived ones, then lets go', async () => {
    const { commands, hook } = setUp();
    act(() => hook.result.current.setOn(true));
    act(() => {
      hook.result.current.selection.onToggle('tasks/a.md');
      hook.result.current.selection.onToggle('tasks/b.md');
      hook.result.current.selection.onToggle('Archive/tasks/c.md');
    });

    const actions = hook.result.current.actions;
    expect(actions.map((action) => action.label)).toEqual(['Archive 2 notes', 'Unarchive note']);
    act(() => actions[0]?.onRun());
    expect(commands.archive).toHaveBeenCalledWith(['tasks/a.md', 'tasks/b.md']);
    // Archiving lets go of what it archived; the archived note it was not given stays.
    await waitFor(() =>
      expect([...hook.result.current.selection.selected]).toEqual(['Archive/tasks/c.md']),
    );
  });

  it('keeps the choice while the batch runs, then only what could not go (A20-05)', async () => {
    const { commands, hook } = setUp();
    let finish: (outcome: ArchiveOutcome) => void = () => {};
    vi.mocked(commands.archive).mockReturnValue(
      new Promise<ArchiveOutcome>((resolve) => (finish = resolve)),
    );
    act(() => hook.result.current.setOn(true));
    act(() => {
      hook.result.current.selection.onToggle('tasks/a.md');
      hook.result.current.selection.onToggle('tasks/b.md');
    });
    act(() => hook.result.current.actions[0]?.onRun());
    expect(hook.result.current.count).toBe(2);

    await act(async () => finish(settled(['tasks/b.md'])));
    expect(hook.result.current.count).toBe(1);
    expect([...hook.result.current.selection.selected]).toEqual(['tasks/b.md']);
  });

  it('keeps a row chosen while the batch runs, and chooses a failed one again (#201)', async () => {
    const { commands, hook } = setUp();
    let finish: (outcome: ArchiveOutcome) => void = () => {};
    vi.mocked(commands.archive).mockReturnValue(
      new Promise<ArchiveOutcome>((resolve) => (finish = resolve)),
    );
    act(() => hook.result.current.setOn(true));
    act(() => {
      hook.result.current.selection.onToggle('tasks/a.md');
      hook.result.current.selection.onToggle('tasks/b.md');
    });
    act(() => hook.result.current.actions[0]?.onRun());
    act(() => {
      hook.result.current.selection.onToggle('tasks/c.md');
      hook.result.current.selection.onToggle('tasks/b.md');
    });

    await act(async () => finish(settled(['tasks/b.md'])));
    expect([...hook.result.current.selection.selected].sort()).toEqual([
      'tasks/b.md',
      'tasks/c.md',
    ]);
  });

  it('chooses every row again when every one fails', async () => {
    const { commands, hook } = setUp();
    vi.mocked(commands.archive).mockResolvedValue(settled(['tasks/a.md', 'tasks/b.md']));
    act(() => hook.result.current.setOn(true));
    act(() => {
      hook.result.current.selection.onToggle('tasks/a.md');
      hook.result.current.selection.onToggle('tasks/b.md');
    });
    await act(async () => hook.result.current.actions[0]?.onRun());
    expect([...hook.result.current.selection.selected].sort()).toEqual([
      'tasks/a.md',
      'tasks/b.md',
    ]);
  });

  it('settles each action on its own rows, leaving the others chosen', async () => {
    const { commands, hook } = setUp();
    act(() => hook.result.current.setOn(true));
    act(() => {
      hook.result.current.selection.onToggle('tasks/a.md');
      hook.result.current.selection.onToggle('Archive/tasks/c.md');
    });
    await act(async () => hook.result.current.actions[0]?.onRun());
    expect(commands.archive).toHaveBeenCalledWith(['tasks/a.md']);
    expect([...hook.result.current.selection.selected]).toEqual(['Archive/tasks/c.md']);
  });

  it('does not choose a row again for a failure at a path it was not given', async () => {
    const { commands, hook } = setUp();
    // A stamp failure lands at the note's new path; a link failure at another note.
    vi.mocked(commands.archive).mockResolvedValue(
      settled(['Archive/tasks/a.md', 'notes/linking.md']),
    );
    act(() => hook.result.current.setOn(true));
    act(() => hook.result.current.selection.onToggle('tasks/a.md'));
    await act(async () => hook.result.current.actions[0]?.onRun());
    expect(hook.result.current.count).toBe(0);
  });

  it('keeps the choice, and says why, when a command throws instead of settling', async () => {
    const { commands, hook } = setUp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(commands.archive).mockRejectedValue(new Error('vault gone'));
    act(() => hook.result.current.setOn(true));
    act(() => hook.result.current.selection.onToggle('tasks/a.md'));
    await act(async () => hook.result.current.actions[0]?.onRun());
    await waitFor(() => expect(logged).toHaveBeenCalled());
    expect(hook.result.current.count).toBe(1);
    logged.mockRestore();
  });

  it('keeps the whole choice when the batch did not start (A20-05)', async () => {
    const { commands, hook } = setUp();
    vi.mocked(commands.archive).mockResolvedValue(null);
    act(() => hook.result.current.setOn(true));
    act(() => hook.result.current.selection.onToggle('tasks/a.md'));
    await act(async () => hook.result.current.actions[0]?.onRun());
    expect(hook.result.current.count).toBe(1);
  });

  it('offers nothing it cannot do, and nothing with no rows chosen', () => {
    const { hook } = setUp();
    act(() => hook.result.current.setOn(true));
    expect(hook.result.current.actions).toEqual([]);
    act(() => hook.result.current.selection.onToggle('.atlas/templates/Task.md'));
    expect(hook.result.current.actions).toEqual([]);
  });

  it('lets go of the choice, and leaves select mode, when the view changes', () => {
    const { hook } = setUp();
    act(() => hook.result.current.setOn(true));
    act(() => hook.result.current.selection.onToggle('tasks/a.md'));
    hook.rerender('.atlas/views/Other.md');
    expect(hook.result.current.on).toBe(false);
    expect(hook.result.current.count).toBe(0);
  });

  it('lets go of the choice when select mode is turned off', () => {
    const { hook } = setUp();
    act(() => hook.result.current.setOn(true));
    act(() => hook.result.current.selection.onToggleAll({ paths: ['a.md', 'b.md'], select: true }));
    expect(hook.result.current.count).toBe(2);
    act(() => hook.result.current.setOn(false));
    expect(hook.result.current.count).toBe(0);
  });
});
