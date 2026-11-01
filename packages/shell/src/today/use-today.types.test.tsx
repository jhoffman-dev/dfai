// @vitest-environment jsdom
/**
 * The Today page counts the Inbox by the types the app already holds (#112):
 * the rule the sidebar's count and the Inbox page are read with. When they
 * change, the page is read again by the new rule.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { INBOX_QUERY_MARK, TASK_TYPE_FILE, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useToday } from './use-today.ts';

const OWN_STATUSES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const GTD: readonly ObjectType[] = [TASK_TYPE_FILE.type];
/** What only the rule for a vault whose tasks start in the Inbox asks: clarified tasks left out. */
const LEAVES_CLARIFIED_OUT = "IN ('backlog'";

function today(types: readonly ObjectType[]) {
  const inboxAsked: string[] = [];
  const listed: string[] = [];
  const stable = {
    ports: {
      index: fakeIndexPort({
        query: async (sql) => {
          if (sql.startsWith(INBOX_QUERY_MARK)) inboxAsked.push(sql);
          return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
        },
      }),
      fs: fakeVaultFs({
        listDirectory: async (folder) => {
          listed.push(folder);
          return [];
        },
      }),
      markdown: remarkMarkdown,
    },
    editors: { setPropertiesIfOpen: async () => false } as unknown as OpenEditors,
    activity: recordingActivity(),
    clock: { today: () => '2026-10-13', now: () => Date.UTC(2026, 9, 13, 15) },
    vaultKey: 'vault-a',
    indexKey: '1',
    open: true,
    onSettled: () => {},
  };
  const hook = renderHook((given: readonly ObjectType[]) => useToday({ ...stable, types: given }), {
    initialProps: types,
  });
  return { hook, inboxAsked, listed };
}

describe('useToday — the vault’s types', () => {
  it('counts the Inbox by the types it is given, without reading the type files again', async () => {
    const { hook, inboxAsked, listed } = today(GTD);
    await waitFor(() => expect(hook.result.current.page.today).not.toBeNull());

    expect(inboxAsked).toHaveLength(1);
    expect(inboxAsked[0]).toContain(LEAVES_CLARIFIED_OUT);
    expect(listed).not.toContain('.atlas/types');
  });

  it('reads the page again, by the new rule, when the types change', async () => {
    const { hook, inboxAsked } = today(OWN_STATUSES);
    await waitFor(() => expect(inboxAsked).toHaveLength(1));
    expect(inboxAsked[0]).not.toContain(LEAVES_CLARIFIED_OUT);

    hook.rerender(GTD);

    await waitFor(() => expect(inboxAsked).toHaveLength(2));
    expect(inboxAsked[1]).toContain(LEAVES_CLARIFIED_OUT);
  });
});
