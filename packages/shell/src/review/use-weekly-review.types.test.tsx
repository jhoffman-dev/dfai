// @vitest-environment jsdom
/**
 * The weekly review counts the Inbox by the types the app already holds
 * (#112): the rule the sidebar's count is read with. When they change — the
 * Task type gains GTD's statuses — the review is read again by the new rule.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { INBOX_QUERY_MARK, TASK_TYPE_FILE, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useWeeklyReview } from './use-weekly-review.ts';

const OWN_STATUSES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const GTD: readonly ObjectType[] = [TASK_TYPE_FILE.type];
/** What only the rule for a vault whose tasks start in the Inbox asks: clarified tasks left out. */
const LEAVES_CLARIFIED_OUT = "IN ('backlog'";

function review(types: readonly ObjectType[]) {
  const inboxAsked: string[] = [];
  const listed: string[] = [];
  const ports = {
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
  };
  const stable = {
    ports,
    editors: { setPropertiesIfOpen: async () => false } as unknown as OpenEditors,
    activity: recordingActivity(),
    clock: { today: () => '2026-10-12', now: () => Date.UTC(2026, 9, 12, 12) },
    indexKey: '1',
    open: true,
    onSettled: () => {},
    archiveNote: async () => null,
  };
  const hook = renderHook(
    (given: readonly ObjectType[]) => useWeeklyReview({ ...stable, types: given }),
    { initialProps: types },
  );
  return { hook, inboxAsked, listed };
}

describe('useWeeklyReview — the vault’s types', () => {
  it('counts the Inbox by the types it is given, without reading the type files again', async () => {
    const { hook, inboxAsked, listed } = review(GTD);
    await waitFor(() => expect(hook.result.current.page.review).not.toBeNull());

    expect(inboxAsked).toHaveLength(1);
    expect(inboxAsked[0]).toContain(LEAVES_CLARIFIED_OUT);
    expect(listed).not.toContain('.atlas/types');
  });

  it('reads the review again, by the new rule, when the types change', async () => {
    const { hook, inboxAsked } = review(OWN_STATUSES);
    await waitFor(() => expect(inboxAsked).toHaveLength(1));
    expect(inboxAsked[0]).not.toContain(LEAVES_CLARIFIED_OUT);

    hook.rerender(GTD);

    await waitFor(() => expect(inboxAsked).toHaveLength(2));
    expect(inboxAsked[1]).toContain(LEAVES_CLARIFIED_OUT);
  });
});
