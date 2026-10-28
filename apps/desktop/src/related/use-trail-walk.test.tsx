// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { createVaultPath, noteTitle, type NoteLinks, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '@dfai/application';
import { createTrailMemory } from './trail-memory.ts';
import { useTrailWalk } from './use-trail-walk.ts';

const path = (value: string) => createVaultPath(value);

const LINKS: NoteLinks = {
  outgoing: [{ path: path('Budget.md'), title: 'Budget', via: null }],
  incoming: [
    { path: path('Mara Quill.md'), title: 'Mara Quill', via: 'Owner' },
    { path: path('Budget.md'), title: 'Budget', via: null },
  ],
};

function setUp({ refuse = false }: { refuse?: boolean } = {}) {
  const memory = createTrailMemory();
  const created = new Map<string, string>();
  const attempts: string[] = [];
  const fs = fakeVaultFs({
    createNote: async ({ path: at, contents }) => {
      attempts.push(at);
      if (refuse) throw new Error('the disk at /Users/someone/vault is full');
      created.set(at, contents);
      return 1;
    },
  });
  const index = fakeIndexPort({
    manifest: async () =>
      ['Payroll.md', 'Budget.md', 'Mara Quill.md'].map((at) => ({
        path: at,
        digest: at,
        type: null,
        modified: 1,
        size: 1,
      })),
  });
  const opened: VaultPath[] = [];
  const hook = renderHook(
    ({ at }: { at: VaultPath }) => {
      const trail = useSyncExternalStore(memory.subscribe, () => memory.get('tab-1'));
      return useTrailWalk({
        memory,
        trail,
        tab: 'tab-1',
        path: at,
        links: LINKS,
        related: { kind: 'ready', notes: [{ path: path('Honey.md'), title: 'Honey' }] },
        titleOf: (step) => noteTitle(path(step)),
        onOpenNote: (to) => opened.push(to),
        fs,
        index,
      });
    },
    { initialProps: { at: path('Payroll.md') } },
  );
  return { hook, memory, opened, created, attempts };
}

describe('walking a trail', () => {
  it('draws nothing until a trail is started, then stands on the note', () => {
    const { hook } = setUp();
    expect(hook.result.current.walk).toBeUndefined();
    act(() => hook.result.current.start());
    const walk = hook.result.current.walk!;
    expect(walk.steps.map((step) => step.title)).toEqual(['Payroll']);
    expect(walk.linked.map((note) => note.title)).toEqual(['Budget', 'Mara Quill']);
    expect(walk.related.map((note) => note.title)).toEqual(['Honey']);
  });

  it('opens each note stepped to, and is drawn there only while it is the step', () => {
    const { hook, opened, memory } = setUp();
    act(() => hook.result.current.start());
    act(() => hook.result.current.walk!.onStep(path('Budget.md')));
    expect(opened).toEqual([path('Budget.md')]);
    expect(memory.get('tab-1')).toEqual({ steps: ['Payroll.md', 'Budget.md'], at: 1 });
    // The tab still shows Payroll until it opens Budget: off the step, no bar.
    expect(hook.result.current.walk).toBeUndefined();
    hook.rerender({ at: path('Budget.md') });
    expect(hook.result.current.walk!.at).toBe(1);

    act(() => hook.result.current.walk!.onBack());
    expect(opened.at(-1)).toBe(path('Payroll.md'));
    expect(memory.get('tab-1')!.at).toBe(0);
  });

  it('saves the trail as a note of links and says where', async () => {
    const { hook, created } = setUp();
    act(() => hook.result.current.start());
    act(() => hook.result.current.walk!.onStep(path('Budget.md')));
    hook.rerender({ at: path('Budget.md') });
    act(() => hook.result.current.walk!.onSave());
    await waitFor(() => expect(hook.result.current.walk!.saved).not.toBeNull());
    expect(hook.result.current.walk!.saved!.title).toBe('Trail from Payroll');
    expect(created.get('Trail from Payroll.md')).toBe('1. [[Payroll]]\n2. [[Budget]]\n');
  });

  it('ends the trail', () => {
    const { hook, memory } = setUp();
    const listener = vi.fn();
    memory.subscribe(listener);
    act(() => hook.result.current.start());
    act(() => hook.result.current.walk!.onEnd());
    expect(memory.get('tab-1')).toBeNull();
    expect(hook.result.current.walk).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('says how many steps were gone from the vault when it was saved', async () => {
    const { hook, created } = setUp();
    act(() => hook.result.current.start());
    act(() => hook.result.current.walk!.onStep(path('Gone.md')));
    hook.rerender({ at: path('Gone.md') });
    act(() => hook.result.current.walk!.onSave());
    await waitFor(() => expect(hook.result.current.walk!.saved).not.toBeNull());
    expect(hook.result.current.walk!.saved!.gone).toBe(1);
    expect(created.get('Trail from Payroll.md')).toBe('1. [[Payroll]]\n');
  });

  it('saves once however many times Save is pressed while it saves', async () => {
    const { hook, attempts } = setUp();
    act(() => hook.result.current.start());
    act(() => {
      hook.result.current.walk!.onSave();
      hook.result.current.walk!.onSave();
    });
    await waitFor(() => expect(hook.result.current.walk!.saved).not.toBeNull());
    expect(attempts).toEqual(['Trail from Payroll.md']);
  });

  it('forgets the note it was saved as once the trail walks on', async () => {
    const { hook } = setUp();
    act(() => hook.result.current.start());
    act(() => hook.result.current.walk!.onSave());
    await waitFor(() => expect(hook.result.current.walk!.saved).not.toBeNull());
    act(() => hook.result.current.walk!.onStep(path('Budget.md')));
    hook.rerender({ at: path('Budget.md') });
    expect(hook.result.current.walk!.saved).toBeNull();
  });

  it('says why a save failed, without paths', async () => {
    const { hook } = setUp({ refuse: true });
    act(() => hook.result.current.start());
    act(() => hook.result.current.walk!.onSave());
    await waitFor(() => expect(hook.result.current.walk!.problem).not.toBeNull());
    expect(hook.result.current.walk!.problem).not.toContain('/Users/someone');
    expect(hook.result.current.walk!.saved).toBeNull();
  });
});
