// @vitest-environment jsdom
/**
 * "Add a property" from a note, against an in-memory vault written through the
 * real markdown adapter: onto the type, the type file gains it and the types
 * are read again; into the note alone, the pane writes its empty value and the
 * row shows the kind it was added as.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath, parseObjectType, splitFrontmatter } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type DefinedType, type OpenNote } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { NewProperty } from '@dfai/ui';
import { useAddProperty } from './use-add-property.ts';
import { useNoteProperties } from './use-note-properties.ts';

const TYPE_PATH = '.atlas/types/book.md';
const TYPE_FILE = '---\nname: book\nlabel: Book\nproperties:\n  author: text\n---\n\n# Book\n';

const property = (overrides: Partial<NewProperty>): NewProperty => ({
  label: 'Pages',
  key: 'pages',
  kind: 'number',
  scope: 'type',
  target: null,
  many: false,
  ...overrides,
});

function setUp() {
  const files = new Map([[TYPE_PATH, TYPE_FILE]]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      files.set(path, contents);
      return 2;
    },
  });
  const type: DefinedType = {
    ...parseObjectType(
      remarkMarkdown.frontmatterProperties(splitFrontmatter(TYPE_FILE).frontmatter),
    ),
    path: createVaultPath(TYPE_PATH),
  };
  const setProperty = vi.fn();
  const rememberKind = vi.fn();
  const onTypeSaved = vi.fn();
  const hook = renderHook(() =>
    useAddProperty({
      fs,
      markdown: remarkMarkdown,
      typeName: 'book',
      types: [type],
      setProperty,
      rememberKind,
      onTypeSaved,
    }),
  );
  return { hook, files, setProperty, rememberKind, onTypeSaved };
}

describe('useAddProperty', () => {
  it('writes a property onto the type, and has the types read again', async () => {
    const { hook, files, setProperty, onTypeSaved } = setUp();
    let key = '';
    await act(async () => {
      key = await hook.result.current(property({}));
    });
    expect(key).toBe('pages');
    expect(files.get(TYPE_PATH)).toMatch(/\n {2}author: text\n {2}pages: number\n---/);
    expect(onTypeSaved).toHaveBeenCalledTimes(1);
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('writes a relation to several notes onto the type with its target', async () => {
    const { hook, files } = setUp();
    await act(async () => {
      await hook.result.current(
        property({ label: 'Tasks', key: 'tasks', kind: 'relation', target: 'book', many: true }),
      );
    });
    expect(files.get(TYPE_PATH)).toMatch(
      / {2}tasks:\n {4}kind: relation\n {4}target: book\n {4}many: true\n/,
    );
  });

  it('writes a property into the note alone at the empty value of its kind', async () => {
    const { hook, files, setProperty, rememberKind, onTypeSaved } = setUp();
    await act(async () => {
      await hook.result.current(
        property({ label: 'Signed', key: 'signed', kind: 'checkbox', scope: 'note' }),
      );
    });
    expect(setProperty).toHaveBeenCalledExactlyOnceWith('signed', false);
    expect(rememberKind).toHaveBeenCalledWith('signed', 'checkbox');
    expect(files.get(TYPE_PATH)).toBe(TYPE_FILE);
    expect(onTypeSaved).not.toHaveBeenCalled();
  });

  it('passes on why a property could not go onto the type', async () => {
    const { hook, files } = setUp();
    await expect(
      hook.result.current(property({ kind: 'relation', target: 'nowhere' })),
    ).rejects.toThrow();
    expect(files.get(TYPE_PATH)).toBe(TYPE_FILE);
  });
});

describe('useNoteProperties: a property the type does not declare', () => {
  const note = (properties: Record<string, unknown>, path = 'Dune.md'): OpenNote =>
    ({ path: createVaultPath(path), properties }) as unknown as OpenNote;
  const kinds = (rows: readonly { def: { key: string; kind: string } }[]) =>
    Object.fromEntries(rows.map((row) => [row.def.key, row.def.kind]));

  // Made once: a new index or note on every render is a new render after it.
  const index = fakeIndexPort();
  const types: DefinedType[] = [];

  it('is shown with the editor its value calls for, under a readable name', () => {
    const open = note({ signed: false, pages: 412, due: '2026-09-24', owner: 'Ada' });
    const { result } = renderHook(() => useNoteProperties({ note: open, types, index }));
    expect(kinds(result.current.rows)).toEqual({
      signed: 'checkbox',
      pages: 'number',
      due: 'date',
      owner: 'text',
    });
    expect(result.current.rows[0]?.def.label).toBe('Signed');
  });

  it('keeps the kind it was added as while its value is still empty, on that note only', () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: OpenNote }) => useNoteProperties({ note: open, types, index }),
      { initialProps: { open: note({ pages: '' }) } },
    );
    expect(kinds(result.current.rows)).toEqual({ pages: 'text' });
    act(() => result.current.rememberKind('pages', 'number'));
    expect(kinds(result.current.rows)).toEqual({ pages: 'number' });

    rerender({ open: note({ pages: '' }, 'Emma.md') });
    expect(kinds(result.current.rows)).toEqual({ pages: 'text' });
  });
});
