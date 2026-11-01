// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  parentVaultPath,
  vaultPathName,
  type ObjectType,
  type PropertyDef,
  type VaultEntry,
} from '@dfai/domain';
import { fakeVaultFs, type OpenEditorsPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useTemplates } from '../types/use-templates.ts';
import { useTemplatesPage } from './use-templates-page.ts';

const property = (key: string): PropertyDef => ({
  key,
  kind: 'text',
  label: key,
  required: false,
  options: [],
  target: null,
  many: false,
});
const PERSON: ObjectType = { name: 'person', label: 'Person', properties: [property('role')] };
const MEETING: ObjectType = { name: 'meeting', label: 'Meeting', properties: [] };

/** The vault's files in memory, with the folders that hold them. */
function memoryFs(files: Record<string, string>) {
  const notes = new Map(Object.entries(files));
  const trashed: string[] = [];
  const entriesIn = (folder: string): VaultEntry[] => {
    const children = new Map<string, VaultEntry>();
    for (const path of notes.keys()) {
      const segments = path.split('/');
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const at = createVaultPath(segments.slice(0, depth).join('/'));
        if (parentVaultPath(at) !== folder) continue;
        const kind = depth === segments.length ? 'file' : 'directory';
        children.set(at, { kind, name: vaultPathName(at), path: at });
      }
    }
    return [...children.values()];
  };
  const fs = fakeVaultFs({
    listDirectory: async (path) => entriesIn(path),
    readTextFile: async (path) => ({ text: notes.get(path) ?? '', modified: 1 }),
    createNote: async ({ path, contents }) => {
      notes.set(path, contents);
      return 0;
    },
    moveEntry: async ({ from, to }) => {
      const text = notes.get(from);
      if (text === undefined) throw new Error('It is not there any more.');
      notes.set(to, text);
      notes.delete(from);
    },
    trashEntry: async ({ path }) => {
      if (!notes.delete(path)) throw new Error('It is not there any more.');
      trashed.push(path);
    },
  });
  return { fs, notes, trashed };
}

const editors = (): OpenEditorsPort => ({
  state: () => 'clean',
  flush: async () => {},
  follow: vi.fn(),
  abandon: vi.fn(),
});

function setUp(files: Record<string, string>) {
  const vault = memoryFs(files);
  const onOpen = vi.fn();
  const onChanged = vi.fn();
  const closeNotes = vi.fn();
  const overlay = { show: vi.fn(), hide: vi.fn() };
  // Held across renders, as the app holds them.
  const props = {
    ports: { fs: vault.fs, markdown: remarkMarkdown, editors: editors(), closeNotes, overlay },
    types: [PERSON, MEETING],
    onChanged,
    onOpen,
  };
  // The folder listed as the window lists it, once.
  const hook = renderHook(() => {
    const { listed } = useTemplates({ fs: vault.fs, vaultKey: '/vault' });
    return useTemplatesPage({ ...props, listed });
  }, queryWrapper());
  return { hook, vault, onOpen, onChanged, closeNotes, overlay };
}

describe('the templates, as the app carries out their commands', () => {
  it('lists the templates and the types that have none', async () => {
    const { hook } = setUp({ '.atlas/templates/Person.md': '---\ntype: person\n---\n' });
    await waitFor(() => expect(hook.result.current.page.catalog).not.toBeNull());
    const catalog = hook.result.current.page.catalog!;
    expect(catalog.templates.map((template) => template.name)).toEqual(['Person']);
    expect(catalog.typesWithout).toEqual([
      { name: 'meeting', label: 'Meeting', templateName: 'Meeting' },
    ]);
  });

  it('makes a type’s missing template, holding its properties as empty keys, and opens it', async () => {
    const { hook, vault, onOpen, onChanged } = setUp({});
    await act(async () => hook.result.current.editTypeTemplate('person'));
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    expect(onOpen).toHaveBeenCalledWith('.atlas/templates/Person.md');
    // Through the real frontmatter writer: `role:` with nothing after it, not `role: ""`.
    expect(vault.notes.get('.atlas/templates/Person.md')).toBe('---\ntype: person\nrole:\n---\n');
    expect(onChanged).toHaveBeenCalled();
  });

  it('opens a type’s template that is already there, writing nothing', async () => {
    const before = '---\ntype: person\nrole: friend\n---\nHello\n';
    const { hook, vault, onOpen } = setUp({ '.atlas/templates/person.md': before });
    await act(async () => hook.result.current.editTypeTemplate('person'));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('.atlas/templates/person.md'));
    expect([...vault.notes]).toEqual([['.atlas/templates/person.md', before]]);
  });

  it('asks before a delete, then trashes the template and closes its panes', async () => {
    const { hook, vault, closeNotes, overlay } = setUp({ '.atlas/templates/Person.md': 'p' });
    await waitFor(() => expect(hook.result.current.page.catalog).not.toBeNull());
    act(() => hook.result.current.page.onDelete('.atlas/templates/Person.md'));
    expect(overlay.show).toHaveBeenCalledWith('template-delete');
    expect(hook.result.current.question?.name).toBe('Person template');
    expect(vault.trashed).toEqual([]);
    await act(async () => hook.result.current.question?.confirm());
    await waitFor(() => expect(closeNotes).toHaveBeenCalledWith(['.atlas/templates/Person.md']));
    expect(vault.trashed).toEqual(['.atlas/templates/Person.md']);
    expect(overlay.hide).toHaveBeenCalledWith('template-delete');
    expect(hook.result.current.question).toBeNull();
  });

  it('says, before a delete, what will stop being made from the template', async () => {
    const { hook } = setUp({ '.atlas/templates/Person.md': 'p' });
    await waitFor(() => expect(hook.result.current.page.catalog).not.toBeNull());
    act(() => hook.result.current.page.onDelete('.atlas/templates/Person.md'));
    expect(hook.result.current.question?.action).toBe('delete');
    expect(hook.result.current.question?.lost).toEqual([
      { kind: 'type', typeName: 'person', typeLabel: 'Person' },
    ]);
  });

  it('says what a rename would stop, from the types the vault has', async () => {
    const { hook } = setUp({ '.atlas/templates/Person.md': 'p' });
    await waitFor(() => expect(hook.result.current.page.catalog).not.toBeNull());
    const { usesLost } = hook.result.current.page;
    expect(usesLost('.atlas/templates/Person.md', 'Contact')).toEqual([
      { kind: 'type', typeName: 'person', typeLabel: 'Person' },
    ]);
    expect(usesLost('.atlas/templates/Person.md', 'PERSON')).toEqual([]);
  });

  it('asks before turning a template into a note, then moves it, untouched, and opens it', async () => {
    const text = '---\ntype: company\n---\nOur client.\n';
    const from = '.atlas/templates/Larkspur Payroll.md';
    const { hook, vault, overlay, onOpen, onChanged } = setUp({ [from]: text });
    await waitFor(() => expect(hook.result.current.page.catalog).not.toBeNull());
    act(() => hook.result.current.page.onMoveToNotes(from));
    expect(overlay.show).toHaveBeenCalledWith('template-to-note');
    expect(hook.result.current.question?.action).toBe('to-note');
    expect(hook.result.current.question?.name).toBe('Larkspur Payroll');
    expect(vault.notes.has(from)).toBe(true);
    await act(async () => hook.result.current.question?.confirm());
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('Larkspur Payroll.md'));
    expect(vault.notes.get('Larkspur Payroll.md')).toBe(text);
    expect(vault.notes.has(from)).toBe(false);
    expect(overlay.hide).toHaveBeenCalledWith('template-to-note');
    expect(onChanged).toHaveBeenCalled();
  });

  it('says why a command failed instead of letting it vanish', async () => {
    const { hook, vault, closeNotes } = setUp({ '.atlas/templates/Person.md': 'p' });
    await waitFor(() => expect(hook.result.current.page.catalog).not.toBeNull());
    act(() => hook.result.current.page.onDelete('.atlas/templates/Person.md'));
    vault.notes.delete('.atlas/templates/Person.md');
    await act(async () => hook.result.current.question?.confirm());
    await waitFor(() =>
      expect(hook.result.current.notice).toBe(
        'The template could not be changed: It is not there any more.',
      ),
    );
    expect(closeNotes).not.toHaveBeenCalled();
  });

  it('renames a template made a moment ago, before the list is read again', async () => {
    const { hook, vault, onChanged } = setUp({});
    await act(async () =>
      hook.result.current.page.onRename({
        path: '.atlas/templates/Fresh.md',
        name: 'Renamed',
      }),
    );
    await waitFor(() => expect(hook.result.current.notice).not.toBeNull());
    // Nothing was there to move: the disk's refusal is said, not swallowed.
    expect(vault.notes.size).toBe(0);
    vault.notes.set('.atlas/templates/Fresh.md', 'f');
    await act(async () =>
      hook.result.current.page.onRename({
        path: '.atlas/templates/Fresh.md',
        name: 'Renamed',
      }),
    );
    await waitFor(() => expect(vault.notes.has('.atlas/templates/Renamed.md')).toBe(true));
    expect(onChanged).toHaveBeenCalled();
  });

  it('checks a name against the templates there, its own excepted', async () => {
    const { hook } = setUp({ '.atlas/templates/Person.md': 'p' });
    await waitFor(() => expect(hook.result.current.page.catalog).not.toBeNull());
    const { nameProblem } = hook.result.current.page;
    expect(nameProblem('person', null)).toBe('There is already a template called “person”.');
    expect(nameProblem('person', '.atlas/templates/Person.md')).toBeNull();
  });
});
