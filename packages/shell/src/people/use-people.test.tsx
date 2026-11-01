// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeIndexPort, fakeVaultFs } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { usePeople } from './use-people.ts';

const julie = createVaultPath('People/Julie.md');
const plan = createVaultPath('Plan.md');

function setUp({ failCreate = false } = {}) {
  const created: string[] = [];
  const index = fakeIndexPort({
    notesOfType: async () => [{ path: julie, title: 'Julie' }],
    manifest: async () => [{ path: julie, modified: 5, size: 1, digest: '', type: null }],
  });
  const fs = fakeVaultFs({
    createNote: async ({ path }) => {
      if (failCreate) throw new Error('disk full');
      created.push(path);
      return 0;
    },
  });
  const onCreated = vi.fn();
  const notePaths: VaultPath[] = [julie, plan];
  const hook = renderHook(
    ({ ready }) =>
      usePeople({
        ports: { fs, markdown: remarkMarkdown, index },
        indexKey: 'ready:1',
        ready,
        notePaths,
        types: [],
        templates: [],
        onCreated,
      }),
    { initialProps: { ready: true } },
  );
  return { ...hook, created, onCreated };
}

describe('usePeople', () => {
  it('offers the vault’s people after @, and draws a link to one as their chip', async () => {
    const { result } = setUp();
    await waitFor(() => expect(result.current.people.suggest('ju')).toHaveLength(2));
    expect(result.current.people.suggest('ju')[0]).toMatchObject({ kind: 'person', name: 'Julie' });
    expect(result.current.people.personFor('Julie')).toEqual({ name: 'Julie', initial: 'J' });
    expect(result.current.people.personFor('Plan')).toBeNull();
  });

  it('makes a new person, tells the app, and answers with the link to write', async () => {
    const { result, created, onCreated } = setUp();
    let target = '';
    await act(async () => {
      target = await result.current.people.create('Ann Lee');
    });
    expect(target).toBe('Ann Lee');
    expect(created).toEqual(['People/Ann Lee.md']);
    expect(onCreated).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
  });

  it('says why a person could not be made, and lets the editor put the text back', async () => {
    const { result, onCreated } = setUp({ failCreate: true });
    await act(async () => {
      await expect(result.current.people.create('Ann')).rejects.toThrow('disk full');
    });
    expect(result.current.error).toBe('Ann could not be added: disk full');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('draws a link to a person just made as their chip at once, before the vault is re-read', async () => {
    const { result } = setUp();
    await waitFor(() => expect(result.current.people.suggest('ju')).toHaveLength(2));
    expect(result.current.people.personFor('Ann Lee')).toBeNull();
    await act(async () => {
      await result.current.people.create('Ann Lee');
    });
    // notePaths still lacks People/Ann Lee.md: the tree has not caught up.
    expect(result.current.people.personFor('Ann Lee')).toEqual({ name: 'Ann Lee', initial: 'A' });
  });

  it('says so when a person was made but the note changed before they could be linked', async () => {
    const { result } = setUp();
    act(() => result.current.people.notLinked('Ann Lee'));
    expect(result.current.error).toMatch(/^Ann Lee was added to People, but not linked/);
  });
});
