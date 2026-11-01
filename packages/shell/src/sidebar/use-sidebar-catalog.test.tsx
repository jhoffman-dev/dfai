// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { useSidebarCatalog } from './use-sidebar-catalog.ts';

const INBOX = '.atlas/views/Inbox.md';
const INBOX_NOTE = ['---', 'atlas: view', 'type: task', '---', '', '# Inbox', ''].join('\n');
const TYPES: readonly ObjectType[] = [];

const isCount = (sql: string) => sql.startsWith('SELECT COUNT(*) AS "value"');

/** Ports built once: new ones on every render would reload the catalogue for ever. */
function fakePorts() {
  const query = vi.fn(async (sql: string) =>
    sql.includes('FROM files')
      ? {
          columns: ['path', 'key', 'value', 'title'],
          rows: [[INBOX, 'atlas', 'view', 'Inbox']],
          truncated: false,
        }
      : { columns: ['value'], rows: [[3]], truncated: false },
  );
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes(INBOX)
        ? [{ path: INBOX, text: INBOX_NOTE, modified: 1, size: INBOX_NOTE.length }]
        : [],
  });
  return { fs, index: fakeIndexPort({ query }), markdown: remarkMarkdown, query };
}

const NO_NOTES: readonly string[] = [];

describe('useSidebarCatalog: quick-view counts', () => {
  it('counts the quick views once per news of the index, with a COUNT', async () => {
    const { fs, index, markdown, query } = fakePorts();
    const counted = () => query.mock.calls.filter(([sql]) => isCount(sql)).length;

    const { wrapper, client } = queryWrapper();
    const reads = createReadInvalidator({ client });
    const { result } = renderHook(
      () =>
        useSidebarCatalog({
          fs,
          markdown,
          index,
          types: TYPES,
          notePaths: NO_NOTES,
          vaultKey: 'vault',
          indexReady: true,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.quick[0]?.count).toBe(3));
    const before = counted();

    reads.indexMoved('vault');
    // Settled: the marks were asked again on the index's news (the sidebar query ran again).
    const sidebarQueries = () => query.mock.calls.filter(([sql]) => sql.includes('FROM files'));
    await waitFor(() => expect(sidebarQueries()).toHaveLength(2));
    await waitFor(() => expect(counted() - before).toBeGreaterThan(0));
    // Let the reloaded catalogue land, and whatever it would set off.
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});

    expect(counted() - before).toBe(1);
  });

  it('counts the quick views again when a type is defined anew under the same name', async () => {
    const { fs, index, markdown, query } = fakePorts();
    const counted = () => query.mock.calls.filter(([sql]) => isCount(sql)).length;
    const task: ObjectType = { name: 'task', label: 'Task', properties: [] };
    const { wrapper } = queryWrapper();
    const hook = renderHook(
      ({ types }: { types: readonly ObjectType[] }) =>
        useSidebarCatalog({
          fs,
          markdown,
          index,
          types,
          notePaths: NO_NOTES,
          vaultKey: 'vault',
          indexReady: true,
        }),
      { wrapper, initialProps: { types: [task] } },
    );
    await waitFor(() => expect(hook.result.current.quick[0]?.count).toBe(3));
    for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
    const before = counted();

    // `.atlas/types/task.md` gains an option: the same name, a new definition. A query
    // view is checked against the types, so it is counted with the new one.
    const withStatus: ObjectType = {
      ...task,
      properties: [
        {
          key: 'status',
          kind: 'select',
          label: 'Status',
          required: false,
          options: ['todo'],
          target: null,
          many: false,
        },
      ],
    };
    hook.rerender({ types: [withStatus] });

    await waitFor(() => expect(counted() - before).toBe(1));
  });
});
