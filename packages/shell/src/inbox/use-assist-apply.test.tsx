// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { recordingActivity, type ArchivePorts, type ModelProvider } from '@dfai/application';
import { automationVault } from '@dfai/application/testing/sqlite';
import { createVaultPath, inboxItem, type InboxItem } from '@dfai/domain';
import type { AssistView } from '@dfai/ui';
import { assistAsks, useInboxAssist, type InboxAssistWiring } from './use-inbox-assist.ts';
import type { InboxWrite } from './use-assist-apply.ts';

/**
 * #909: Apply and Undo as the Inbox's hook holds them. The use-cases are the
 * real ones, over a vault in memory with a real SQL index; the Inbox's write
 * queue is stood in for by one that runs each job when it is let go.
 */

const TODAY = '2026-11-17';
const NOON = Date.parse(`${TODAY}T12:00:00Z`);
const CLOCK = {
  now: () => NOON + 3_600_000,
  today: () => TODAY,
  localNow: () => `${TODAY}T13:00:00`,
};
const json = (frontmatter: Record<string, unknown>, body = '') =>
  `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;

const CALL = 'Inbox/Call Mara.md';
const LUNCH = 'Inbox/Lunch with Tobias.md';
const JUNK = 'Inbox/Buy now.md';
const NOTES: Record<string, string> = {
  'Projects/Larkspur Payroll.md': json({ type: 'project', para: 'project' }),
  'People/Mara Quill.md': json({ type: 'person', email: 'mara.quill@example.com' }),
  [CALL]: 'Call Mara Quill <mara.quill@example.com> about the renewal.\n',
  [LUNCH]: 'Lunch with Tobias Fenn <tobias@example.org>.\n',
  [JUNK]: 'Buy now!\n',
};
const entry = (item: string, extra: Record<string, unknown> = {}) => ({
  item,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'Something to do.',
  duplicateOf: null,
  people: [],
  ...extra,
});
const ANSWER = JSON.stringify({
  items: [
    entry(CALL, {
      projects: ['Projects/Larkspur Payroll.md'],
      people: [{ name: 'Mara Quill', email: null, person: 'People/Mara Quill.md' }],
    }),
    entry(LUNCH, { people: [{ name: 'Tobias Fenn', email: 'tobias@example.org', person: null }] }),
    entry(JUNK, { kind: 'junk' }),
  ],
});
const item = (path: string): InboxItem =>
  inboxItem({ path: createVaultPath(path), title: path.slice('Inbox/'.length, -3), type: null });

function setUp() {
  const vault = automationVault({ notes: NOTES, today: TODAY });
  const index = vault.ports.index;
  const ports: ArchivePorts = {
    fs: vault.ports.fs,
    markdown: vault.ports.markdown,
    editors: vault.ports.editors,
    index: {
      ...index,
      notesOfType: async (type) =>
        (
          await index.query(
            "SELECT f.path, f.title FROM files f JOIN props p ON p.path = f.path AND p.key = 'type' WHERE p.value_text = ?",
            [type],
          )
        ).rows.map(([path, title]) => ({ path: String(path), title: String(title) })),
    },
  };
  const provider: ModelProvider = {
    id: 'claude-code',
    status: async () => ({ ready: true }),
    stream: async function* () {
      yield { type: 'text' as const, text: ANSWER };
    },
  };
  const wiring: InboxAssistWiring = {
    claude: { provider: () => provider, deadline: () => new AbortController().signal },
    asks: assistAsks(),
  };
  // The Inbox's queue, one job at a time, each held until let go when `holding`.
  let holding = false;
  const held: (() => void)[] = [];
  const jobs: Promise<unknown>[] = [];
  const write: InboxWrite = (job) => {
    const ran = (async () => {
      if (holding) await new Promise<void>((resolve) => held.push(resolve));
      const notePaths = [...vault.files.keys()].map((path) => createVaultPath(path));
      return (await job({ notePaths, ports })).done;
    })();
    jobs.push(ran);
    return ran;
  };
  const activity = recordingActivity();
  const hook = renderHook(() =>
    useInboxAssist({
      wiring,
      ports,
      clock: CLOCK,
      items: [CALL, LUNCH, JUNK].map(item),
      vaultKey: '/vault',
      apply: { write, activity },
    }),
  );
  const plan = () => hook.result.current!.view as Extract<AssistView, { kind: 'plan' }>;
  const rowOf = (title: string) => plan().rows.find((each) => each.title === title)!;
  const suggest = async () => {
    act(() => hook.result.current!.onSuggest());
    await waitFor(() => expect(hook.result.current!.view?.kind).toBe('plan'));
  };
  return {
    vault,
    hook,
    activity,
    plan,
    rowOf,
    suggest,
    actions: () => hook.result.current!.actions!,
    hold: () => void (holding = true),
    /** Every job asked for so far, run to its end. */
    settled: () => act(async () => void (await Promise.all(jobs))),
    jobCount: () => jobs.length,
    letGo: () => held.splice(0).forEach((resolve) => resolve()),
  };
}

describe('useInboxAssist: Apply and Undo', () => {
  it('offers Apply on each planned row and on none of the questions', async () => {
    const t = setUp();
    await t.suggest();
    expect(t.rowOf('Call Mara').action).toEqual({ kind: 'apply', said: null });
    expect(t.rowOf('Buy now').action).toEqual({ kind: 'none' });
    expect(t.plan()).toMatchObject({ canApplyAll: true, canUndoAll: false, busy: false });
  });

  it('applies one row, says so, and undoes it to the byte', async () => {
    const t = setUp();
    await t.suggest();
    act(() => t.actions().onApply(CALL));
    await waitFor(() => expect(t.rowOf('Call Mara').action.kind).toBe('applied'));
    expect(t.rowOf('Call Mara').action).toMatchObject({
      words: 'Made it a task under Larkspur Payroll. Linked Mara Quill.',
    });
    expect(t.plan().said).toBe(
      'Call Mara: Made it a task under Larkspur Payroll. Linked Mara Quill.',
    );
    expect(t.vault.files.has(CALL)).toBe(false);
    expect(t.plan().canUndoAll).toBe(true);

    act(() => t.actions().onUndo(CALL));
    await waitFor(() => expect(t.rowOf('Call Mara').action.kind).toBe('undone'));
    expect(t.vault.files.get(CALL)).toBe(NOTES[CALL]);
    expect(t.activity.reports.map((report) => report.message.split(':')[0])).toEqual([
      'Inbox assist applied “Call Mara”',
      'Inbox assist undid “Call Mara”',
    ]);
  });

  it('applies all sure rows, skipping the question, and undoes all', async () => {
    const t = setUp();
    await t.suggest();
    act(() => t.actions().onApplyAll());
    await waitFor(() => expect(t.plan().busy).toBe(false));
    expect(t.rowOf('Call Mara').action.kind).toBe('applied');
    expect(t.rowOf('Lunch with Tobias').action.kind).toBe('applied');
    expect(t.rowOf('Buy now').action).toEqual({ kind: 'none' });
    expect(t.vault.files.has('People/Tobias Fenn.md')).toBe(true);
    expect(t.plan().canApplyAll).toBe(false);

    act(() => t.actions().onUndoAll());
    await waitFor(() => expect(t.rowOf('Call Mara').action.kind).toBe('undone'));
    await waitFor(() => expect(t.rowOf('Lunch with Tobias').action.kind).toBe('undone'));
    for (const [path, text] of Object.entries(NOTES)) expect(t.vault.files.get(path)).toBe(text);
    expect(t.vault.files.has('People/Tobias Fenn.md')).toBe(false);
  });

  it('applies a row once, however often Apply is pressed before it lands', async () => {
    const t = setUp();
    await t.suggest();
    t.hold();
    act(() => {
      t.actions().onApply(CALL);
      t.actions().onApply(CALL);
      t.actions().onApplyAll();
    });
    expect(t.rowOf('Call Mara').action).toEqual({ kind: 'busy', words: 'Applying…' });
    // Apply all claims only what is not claimed already: Lunch, not Call Mara again.
    expect(t.jobCount()).toBe(2);
    t.letGo();
    await t.settled();
    t.letGo();
    await t.settled();
    expect(t.rowOf('Call Mara').action.kind).toBe('applied');
    // One apply of Call Mara is one log line and one Activity line: the second press did nothing.
    expect(
      t.activity.reports.filter((report) => report.message.includes('Call Mara')),
    ).toHaveLength(1);
  });

  it('starts no row of Apply all once the suggestions are put away', async () => {
    const t = setUp();
    await t.suggest();
    t.hold();
    act(() => t.actions().onApplyAll());
    act(() => t.hook.result.current!.onDismiss());
    expect(t.jobCount()).toBe(1);
    t.letGo();
    await t.settled();
    expect(t.activity.reports).toEqual([]);
    for (const [path, text] of Object.entries(NOTES)) expect(t.vault.files.get(path)).toBe(text);
  });
});
