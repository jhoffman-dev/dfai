// @vitest-environment jsdom
/**
 * The Inbox page's hook (#112, #55): it lists what the open vault's index
 * answered and nothing else, clarifies a row through the use-case, shows a
 * refusal on that row, and takes the last clarification back.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type ArchivePorts,
} from '@dfai/application';
import {
  createVaultPath,
  INBOX_LIST_LIMIT,
  INBOX_QUERY_COLUMNS,
  PARA_VALUES_QUERY_MARK,
  TASK_TYPE_FILE,
  type ObjectType,
} from '@dfai/domain';
import { createToasts } from '../toasts/toasts.ts';
import { useInbox, type InboxOptions } from './use-inbox.ts';

const CALL = createVaultPath('Inbox/Call the bank.md');
const CAPTURED = '---\ntype: task\nstatus: inbox\n---\n\nAbout the loan.\n';
const FILES = {
  'Projects/DFAI.md': '---\ntype: project\n---\n',
  'People/Mara Quill.md': '---\ntype: person\n---\n',
  [CALL]: CAPTURED,
};

/** What the index answers the filing picker's question for the projects' PARA: none hold one. */
const NO_PARA = { columns: ['path', 'para'], rows: [], truncated: false };

/** An index that lists `titles` as tasks in the Inbox, and says what it was asked. */
function listingIndex(titles: readonly string[], asked: string[] = []) {
  return fakeIndexPort({
    query: async (sql) => {
      // The filing picker asks for the projects' PARA (#213): no PARA here, so all are projects.
      if (sql.startsWith(PARA_VALUES_QUERY_MARK)) return NO_PARA;
      asked.push(sql);
      return {
        columns: [...INBOX_QUERY_COLUMNS],
        rows: titles.map((title) => [`Inbox/${title}.md`, title, 'task', 0, null, null, 'inbox']),
        truncated: false,
      };
    },
    notesOfType: async (type) =>
      type === 'person'
        ? [
            { path: 'People/Mara Quill.md', title: 'Mara Quill' },
            { path: 'Archive/People/Tobias Fenn.md', title: 'Tobias Fenn' },
          ]
        : [],
  });
}

function inbox(overrides: Partial<InboxOptions> = {}, files: Record<string, string> = FILES) {
  const memory = memoryVault(files);
  const ports: ArchivePorts = {
    fs: fakeVaultFs(memory.fs),
    markdown: fakeMarkdown(),
    index: listingIndex(['Call the bank']),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
  const onSettled = vi.fn();
  const initial: InboxOptions = {
    ports,
    notePaths: [...memory.files.keys()].map(createVaultPath),
    vaultKey: '/vaults/a',
    types: [TASK_TYPE_FILE.type],
    clock: { today: () => '2026-10-11' },
    indexKey: 'ready:1',
    open: true,
    onSettled,
    activity: recordingActivity(),
    closing: { beforeClose: async () => () => {} },
    ...overrides,
  };
  const hook = renderHook((options: InboxOptions) => useInbox(options), { initialProps: initial });
  const listed = () => hook.result.current.contents?.items.map((item) => item.title) ?? null;
  return { hook, initial, files: memory.files, onSettled, listed };
}

describe('useInbox — what it lists', () => {
  it('lists what the index answers, each task with what it says', async () => {
    const { hook, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    expect(hook.result.current.contents?.items[0]?.task?.status).toBe('inbox');
  });

  it('asks for clarified tasks to be left out only once the vault’s tasks start in the Inbox', async () => {
    const legacy: ObjectType = { name: 'task', label: 'Task', properties: [] };
    for (const [types, leavesClarifiedOut] of [
      [[TASK_TYPE_FILE.type], true],
      [[legacy], false],
    ] as const) {
      const asked: string[] = [];
      const index = listingIndex([], asked);
      const { hook, initial } = inbox({ types });
      hook.rerender({ ...initial, ports: { ...initial.ports, index }, indexKey: 'ready:2' });
      await waitFor(() => expect(asked.length).toBeGreaterThan(0));
      expect(asked.at(-1)?.includes("IN ('backlog'")).toBe(leavesClarifiedOut);
    }
  });

  it('offers the people a task can wait on, never an archived one', async () => {
    const { hook } = inbox();
    await waitFor(() => expect(hook.result.current.people.length).toBeGreaterThan(0));
    expect(hook.result.current.people.map((person) => person.path)).toEqual([
      'People/Mara Quill.md',
    ]);
  });
});

describe('useInbox — while the same vault re-indexes', () => {
  it('keeps what it last listed up, so a row keeps what was picked on it, and asks nothing', async () => {
    const asked: string[] = [];
    const { hook, initial, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    const working = { ...initial.ports, index: listingIndex(['Later'], asked) };

    hook.rerender({ ...initial, ports: working, indexKey: 'working', indexReady: false });
    await act(async () => {});

    expect(listed()).toEqual(['Call the bank']);
    expect(asked).toEqual([]);
  });
});

/** #55: after a vault switch the last vault's rows, and their actions, are gone at once. */
describe('useInbox — a vault switch', () => {
  it('shows nothing of the last vault while the index still holds its rows', async () => {
    const { hook, initial, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));

    // The vault changed; the index has not started on it, and still says ready.
    hook.rerender({ ...initial, vaultKey: '/vaults/b' });

    expect(listed()).toBeNull();
    expect(hook.result.current.filing).toEqual([]);
    expect(hook.result.current.people).toEqual([]);
  });

  it('does not ask the index, nor show a late answer, until it has read the new vault', async () => {
    const asked: string[] = [];
    const { hook, initial, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    const stale = { ...initial.ports, index: listingIndex(['Call the bank'], asked) };

    hook.rerender({ ...initial, ports: stale, vaultKey: '/vaults/b' });
    hook.rerender({ ...initial, ports: stale, vaultKey: '/vaults/b', indexReady: false });
    await act(async () => {});
    expect(asked).toEqual([]);
    expect(listed()).toBeNull();

    const fresh = { ...initial.ports, index: listingIndex(['Order seeds'], asked) };
    hook.rerender({ ...initial, ports: fresh, vaultKey: '/vaults/b', indexKey: 'ready:2' });
    await waitFor(() => expect(listed()).toEqual(['Order seeds']));
  });

  it('keeps the new vault’s rows up when its index re-reads under the key it switched on', async () => {
    const { hook, initial, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    // The index had already started on the new vault when the switch rendered.
    const working = { ...initial, vaultKey: '/vaults/b', indexKey: 'working', indexReady: false };
    hook.rerender(working);
    const fresh = { ...initial.ports, index: listingIndex(['Order seeds']) };
    hook.rerender({ ...working, ports: fresh, indexKey: 'ready:2', indexReady: true });
    await waitFor(() => expect(listed()).toEqual(['Order seeds']));

    // The same vault re-indexes: 'working' again, the key the switch was made under.
    hook.rerender({ ...working, ports: fresh });

    expect(listed()).toEqual(['Order seeds']);
  });

  it('clarifies nothing in the window before the new vault is read', async () => {
    const { hook, initial, files, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    hook.rerender({ ...initial, vaultKey: '/vaults/b' });

    let done = true;
    await act(async () => {
      done = await hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action' },
      });
    });

    expect(done).toBe(false);
    expect(files.get(CALL)).toBe(CAPTURED);
  });

  it('keeps one last-action object across renders, so its bar keeps its time (review)', async () => {
    const { hook, initial } = inbox();
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'backlog' } }),
    );
    const shown = hook.result.current.lastAction;
    expect(shown).toEqual({ title: 'Call the bank' });
    hook.rerender({ ...initial });
    expect(hook.result.current.lastAction).toBe(shown);
  });

  it('forgets the last vault’s refusal and its undo', async () => {
    const { hook, initial } = inbox();
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'backlog' } }),
    );
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { due: '2026-13-45' } }),
    );
    expect(hook.result.current.lastAction).toEqual({ title: 'Call the bank' });
    expect(hook.result.current.refusals).not.toEqual([]);

    hook.rerender({ ...initial, vaultKey: '/vaults/b' });

    expect(hook.result.current.lastAction).toBeNull();
    expect(hook.result.current.refusals).toEqual([]);
  });
});

describe('useInbox — clarifying a row', () => {
  it('writes the row in one go, settles, and offers to take it back', async () => {
    const { hook, files, onSettled } = inbox();
    let done = false;
    await act(async () => {
      done = await hook.result.current.clarify({
        path: CALL,
        clarification: {
          status: 'waiting',
          waitingOn: createVaultPath('People/Mara Quill.md'),
          project: createVaultPath('Projects/DFAI.md'),
        },
      });
    });

    expect(done).toBe(true);
    expect(files.get('Tasks/2026/10/Call the bank.md')).toBe(
      '---\ntype: task\nstatus: waiting\nwaiting_on: [[Mara Quill]]\nproject: [[DFAI]]\n---\n\nAbout the loan.\n',
    );
    expect(onSettled).toHaveBeenCalledOnce();
    expect(hook.result.current.refusals).toEqual([]);
    expect(hook.result.current.lastAction).toEqual({ title: 'Call the bank' });
  });

  it('shows a refusal on its row, writes nothing, and keeps the undo of the action before', async () => {
    const { hook, files, onSettled } = inbox();
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { due: '2026-10-20' } }),
    );
    const before = files.get(CALL);

    let done = true;
    await act(async () => {
      done = await hook.result.current.clarify({
        path: CALL,
        clarification: { due: '2026-13-45' },
      });
    });

    expect(done).toBe(false);
    expect(hook.result.current.refusals).toEqual([
      {
        path: CALL,
        reason: '“2026-13-45” is not a day (YYYY-MM-DD).',
      },
    ]);
    expect(files.get(CALL)).toBe(before);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(hook.result.current.lastAction).toEqual({ title: 'Call the bank' });
  });

  it('clarifies a row to Waiting with nobody to wait on, asking for no one (#202)', async () => {
    const { hook, files } = inbox();
    let done = false;
    await act(async () => {
      done = await hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'waiting' },
      });
    });
    expect(done).toBe(true);
    expect(hook.result.current.refusals).toEqual([]);
    expect(files.get(CALL)).toBe('---\ntype: task\nstatus: waiting\n---\n\nAbout the loan.\n');
  });

  it('dates a task finished from the row by the injected clock', async () => {
    const { hook, files } = inbox({ clock: { today: () => '2026-12-24' } });
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'archive' } }),
    );
    expect(files.get(CALL)).toContain('completed: 2026-12-24');
  });
});

/**
 * An index that answers the Inbox's statements over `waiting` as SQLite would
 * (a jsdom test cannot load SQLite): newest first, then by path; a page after
 * its `after` key and up to its `through` key; and the count. Every statement
 * asked is kept, with its parameters.
 */
function keysetIndex(waiting: { title: string; modified: number }[]) {
  const asked: { sql: string; parameters: readonly unknown[] }[] = [];
  const pathOf = (title: string) => `Inbox/${title}.md`;
  const order = (a: { title: string; modified: number }, b: { title: string; modified: number }) =>
    b.modified - a.modified || (pathOf(a.title) < pathOf(b.title) ? -1 : 1);
  const index = fakeIndexPort({
    query: async (sql, parameters = []) => {
      if (sql.startsWith(PARA_VALUES_QUERY_MARK)) return NO_PARA;
      asked.push({ sql, parameters });
      if (sql.includes('count(*) AS "total"')) {
        return { columns: ['total'], rows: [[waiting.length]], truncated: false };
      }
      const given = [...parameters] as (string | number)[];
      const take = () => [given.shift(), given.shift(), given.shift()] as [number, number, string];
      const after = sql.includes('files.path > ?') ? take() : null;
      const through = sql.includes('files.path <= ?') ? take() : null;
      const [limit] = given as number[];
      const rows = [...waiting]
        .sort(order)
        .filter(({ title, modified }) => {
          const path = pathOf(title);
          const isAfter =
            after === null || modified < after[0] || (modified === after[0] && path > after[2]);
          const isThrough =
            through === null ||
            modified > through[0] ||
            (modified === through[0] && path <= through[2]);
          return isAfter && isThrough;
        })
        .slice(0, limit)
        .map(({ title, modified }) => {
          const row: unknown[] = INBOX_QUERY_COLUMNS.map(() => null);
          const put = (column: (typeof INBOX_QUERY_COLUMNS)[number], value: unknown) =>
            (row[INBOX_QUERY_COLUMNS.indexOf(column)] = value);
          put('path', pathOf(title));
          put('title', title);
          put('type', 'task');
          put('importStamped', 0);
          put('status', 'inbox');
          put('modified', modified);
          return row;
        });
      return { columns: [...INBOX_QUERY_COLUMNS], rows, truncated: false };
    },
  });
  return { index, asked };
}

/** `count` tasks waiting, the newest first: `Task 0` changed last. */
const waitingTasks = (count: number) =>
  Array.from({ length: count }, (_, n) => ({ title: `Task ${n}`, modified: count - n }));

const isPage = (sql: string) => !sql.includes('count(*) AS "total"');

describe('useInbox — more than one page (#167)', () => {
  it('lists the next page once more are asked for, read on from the last note shown', async () => {
    const waiting = waitingTasks(INBOX_LIST_LIMIT * 2 + 3);
    const { index, asked } = keysetIndex(waiting);
    const { hook, initial } = inbox();
    hook.rerender({ ...initial, ports: { ...initial.ports, index } });
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT));
    expect(hook.result.current.contents).toMatchObject({ truncated: true, total: waiting.length });

    asked.length = 0;
    act(() => hook.result.current.showMore());
    await waitFor(() =>
      expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT * 2),
    );
    act(() => hook.result.current.showMore());
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(waiting.length));

    expect(hook.result.current.contents?.truncated).toBe(false);
    expect(hook.result.current.contents?.items.map((item) => item.title)).toEqual(
      waiting.map((task) => task.title),
    );
    // Each Show more read one page, on from the last note shown — never from the top again.
    const pages = asked.filter(({ sql }) => isPage(sql));
    expect(pages).toHaveLength(2);
    for (const { sql, parameters } of pages) {
      expect(sql).toContain('files.path > ?');
      expect(parameters.at(-1)).toBe(INBOX_LIST_LIMIT + 1);
    }
  });

  it('reads again up to the last note shown, a page at a time, when the index changes', async () => {
    const waiting = waitingTasks(INBOX_LIST_LIMIT * 2 + 3);
    const { index, asked } = keysetIndex(waiting);
    const { hook, initial } = inbox();
    const at = { ...initial, ports: { ...initial.ports, index } };
    hook.rerender(at);
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT));
    act(() => hook.result.current.showMore());
    await waitFor(() =>
      expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT * 2),
    );

    // Two of the first page filed meanwhile: the rest shown stay, and nothing past them comes in.
    waiting.splice(0, 2);
    asked.length = 0;
    hook.rerender({ ...at, indexKey: 'ready:2' });
    await waitFor(() =>
      expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT * 2 - 2),
    );
    expect(hook.result.current.contents?.items[0]?.title).toBe('Task 2');
    expect(hook.result.current.contents?.items.at(-1)?.title).toBe(
      `Task ${INBOX_LIST_LIMIT * 2 - 1}`,
    );
    expect(hook.result.current.contents).toMatchObject({ truncated: true, total: waiting.length });
    for (const { parameters } of asked.filter(({ sql }) => isPage(sql))) {
      expect(parameters.at(-1)).toBe(INBOX_LIST_LIMIT + 1);
    }

    // Show more then reads on from there, skipping none of the three left.
    act(() => hook.result.current.showMore());
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(waiting.length));
    expect(hook.result.current.contents?.items.map((item) => item.title)).toEqual(
      waiting.map((task) => task.title),
    );
  });

  it('starts another vault at its first page', async () => {
    const waiting = waitingTasks(INBOX_LIST_LIMIT + 3);
    const { index } = keysetIndex(waiting);
    const { hook, initial } = inbox();
    const at = { ...initial, ports: { ...initial.ports, index } };
    hook.rerender(at);
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT));
    act(() => hook.result.current.showMore());
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(waiting.length));

    const other = keysetIndex(waitingTasks(INBOX_LIST_LIMIT + 3));
    const b = { ...at, vaultKey: '/vaults/b', ports: { ...at.ports, index: other.index } };
    hook.rerender(b);
    hook.rerender({ ...b, indexKey: 'ready:b' });
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT));
  });
});

/**
 * The index of {@link keysetIndex}, its first-page reads and its read-on pages
 * each held until let go: so a re-read and a Show more can be landed in
 * either order.
 */
function heldIndex(waiting: { title: string; modified: number }[]) {
  const { index } = keysetIndex(waiting);
  const gate = () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    return { held, release };
  };
  const gates = { firstPage: gate(), readOn: gate() };
  const holding = { firstPage: false, readOn: false };
  const query: typeof index.query = async (sql, parameters) => {
    const firstPage = isPage(sql) && !sql.includes('files.path > ?') && !sql.includes('<= ?');
    if (firstPage && holding.firstPage) await gates.firstPage.held;
    if (sql.includes('files.path > ?') && holding.readOn) await gates.readOn.held;
    return index.query(sql, parameters);
  };
  return {
    index: { ...index, query },
    hold: (which: keyof typeof holding) => (holding[which] = true),
    release: async (which: keyof typeof holding) => {
      holding[which] = false;
      await act(async () => gates[which].release());
    },
  };
}

describe('useInbox — Show more while the list is being read again (#167)', () => {
  async function shownFirstPage(waiting: { title: string; modified: number }[]) {
    const held = heldIndex(waiting);
    const { hook, initial } = inbox();
    const at = { ...initial, ports: { ...initial.ports, index: held.index } };
    hook.rerender(at);
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT));
    return { hook, at, held };
  }
  const titles = (hook: { result: { current: ReturnType<typeof useInbox> } }) =>
    hook.result.current.contents?.items.map((item) => item.title) ?? [];

  it('keeps the page it added when the read begun before it lands after it', async () => {
    const waiting = waitingTasks(INBOX_LIST_LIMIT * 2 + 3);
    const { hook, at, held } = await shownFirstPage(waiting);

    held.hold('firstPage');
    hook.rerender({ ...at, indexKey: 'ready:2' });
    await act(async () => {});
    held.hold('readOn');
    act(() => hook.result.current.showMore());
    await act(async () => {});

    await held.release('readOn');
    expect(hook.result.current.contents?.items).toHaveLength(INBOX_LIST_LIMIT * 2);
    await held.release('firstPage');
    await act(async () => {});

    expect(titles(hook)).toEqual(waiting.slice(0, INBOX_LIST_LIMIT * 2).map((task) => task.title));
  });

  it('never brings back the list it was asked from when the read begun before it lands first', async () => {
    const waiting = waitingTasks(INBOX_LIST_LIMIT * 2 + 3);
    const { hook, at, held } = await shownFirstPage(waiting);

    // The first task is filed: the index changes, and Show more is asked for before its re-read lands.
    const [filed] = waiting.splice(0, 1);
    held.hold('firstPage');
    hook.rerender({ ...at, indexKey: 'ready:2' });
    await act(async () => {});
    held.hold('readOn');
    act(() => hook.result.current.showMore());
    await act(async () => {});

    await held.release('firstPage');
    expect(titles(hook)[0]).toBe('Task 1');
    await held.release('readOn');
    await act(async () => {});

    await waitFor(() => expect(titles(hook)).toHaveLength(INBOX_LIST_LIMIT * 2 - 1));
    expect(titles(hook)).not.toContain(filed?.title);
    expect(titles(hook)).toEqual(
      waiting.slice(0, INBOX_LIST_LIMIT * 2 - 1).map((task) => task.title),
    );
  });
});

describe('useInbox — undo', () => {
  it('moves the note back and puts back what it said', async () => {
    const { hook, files, onSettled } = inbox();
    await act(() =>
      hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action', project: createVaultPath('Projects/DFAI.md') },
      }),
    );
    expect(files.has(CALL)).toBe(false);
    expect(files.has('Tasks/2026/10/Call the bank.md')).toBe(true);

    await act(() => hook.result.current.undo());

    expect(files.get(CALL)).toBe(CAPTURED);
    expect(files.has('Tasks/2026/10/Call the bank.md')).toBe(false);
    expect(hook.result.current.lastAction).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it('takes nothing back once the bar offering Undo has gone (#165)', async () => {
    const { hook, files, onSettled } = inbox();
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'backlog' } }),
    );
    const clarified = files.get(CALL);
    expect(hook.result.current.lastAction).toEqual({ title: 'Call the bank' });

    act(() => hook.result.current.dismissLastAction());
    expect(hook.result.current.lastAction).toBeNull();

    await act(() => hook.result.current.undo());
    expect(files.get(CALL)).toBe(clarified);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('says why above the list when the note was changed since, and leaves it', async () => {
    const { hook, files } = inbox();
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'backlog' } }),
    );
    files.set(CALL, `${files.get(CALL) ?? ''}Edited since.\n`);

    await act(() => hook.result.current.undo());

    expect(hook.result.current.problem).toBe('It was changed since, so it was left as it is.');
    expect(files.get(CALL)).toContain('Edited since.');
  });
});

describe('useInbox — what it hands every row (#217)', () => {
  it('keeps the same statuses while the types read again say the same ones', async () => {
    const { hook, initial } = inbox();
    await waitFor(() => expect(hook.result.current.contents).not.toBeNull());
    const before = hook.result.current.statuses;

    // The types are read again after every write; the Task type says what it said.
    hook.rerender({ ...initial, types: [{ ...TASK_TYPE_FILE.type }] });

    expect(hook.result.current.statuses).toEqual(before);
    expect(hook.result.current.statuses).toBe(before);
  });

  it('hands over new statuses once the Task type declares others', async () => {
    const { hook, initial } = inbox();
    await waitFor(() => expect(hook.result.current.contents).not.toBeNull());
    const fewer: ObjectType = {
      ...TASK_TYPE_FILE.type,
      properties: TASK_TYPE_FILE.type.properties.map((property) =>
        property.key === 'status' && 'options' in property
          ? { ...property, options: ['inbox', 'next-action'] }
          : property,
      ),
    };

    hook.rerender({ ...initial, types: [fewer] });

    expect(hook.result.current.statuses).toEqual(['inbox', 'next-action']);
  });
});

describe('useInbox — said in the window’s toasts (#320)', () => {
  const pressUndo = async (toasts: ReturnType<typeof createToasts>, at = -1) => {
    const toast = toasts.store.getState().toasts.at(at);
    await act(async () => {
      toast?.onUndo?.();
      toasts.dismiss(toast?.id ?? -1);
    });
  };

  it('says a clarification once it is written, with an Undo that puts the note back', async () => {
    const toasts = createToasts();
    const { hook, files } = inbox({ toasts });
    await act(() =>
      hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action', project: createVaultPath('Projects/DFAI.md') },
      }),
    );
    expect(toasts.store.getState().toasts).toMatchObject([
      { message: 'Clarified “Call the bank”.', tone: 'change' },
    ]);

    await pressUndo(toasts);

    await waitFor(() => expect(files.get(CALL)).toBe(CAPTURED));
    expect(files.has('Tasks/2026/10/Call the bank.md')).toBe(false);
    expect(hook.result.current.lastAction).toBeNull();
  });

  it('lets the undo go with its toast', async () => {
    const toasts = createToasts();
    const { hook, files } = inbox({ toasts });
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'backlog' } }),
    );
    const clarified = files.get(CALL);
    act(() => toasts.dismiss(toasts.store.getState().toasts[0]?.id ?? -1));

    expect(hook.result.current.lastAction).toBeNull();
    await act(() => hook.result.current.undo());
    expect(files.get(CALL)).toBe(clarified);
  });

  it('clears the row’s refusal once its Undo from the toast is written (#455 review)', async () => {
    const toasts = createToasts();
    const { hook, initial } = inbox({ toasts });
    const refusing = {
      ...initial.ports,
      fs: {
        ...initial.ports.fs,
        moveEntry: async () => {
          throw new Error('The disk is full.');
        },
      },
    };
    hook.rerender({ ...initial, ports: refusing });
    await act(() =>
      hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action', project: createVaultPath('Projects/DFAI.md') },
      }),
    );
    expect(hook.result.current.refusals.map((refusal) => refusal.path)).toEqual([CALL]);

    await pressUndo(toasts);

    await waitFor(() => expect(hook.result.current.refusals).toEqual([]));
  });

  it('says nothing was clarified when a filing alone fails, and offers nothing to undo (#225)', async () => {
    const toasts = createToasts();
    const { hook, initial, files } = inbox({ toasts });
    const refusing = {
      ...initial.ports,
      fs: {
        ...initial.ports.fs,
        moveEntry: async () => {
          throw new Error('The disk is full.');
        },
      },
    };
    hook.rerender({ ...initial, ports: refusing });
    await act(() =>
      hook.result.current.clarify({
        path: CALL,
        clarification: { project: createVaultPath('Projects/DFAI.md') },
      }),
    );

    expect(hook.result.current.refusals).toEqual([
      { path: CALL, reason: expect.stringMatching(/The disk is full/) },
    ]);
    expect(files.get(CALL)).toBe(CAPTURED);
    expect(toasts.store.getState().toasts).toEqual([]);
    expect(hook.result.current.lastAction).toBeNull();
  });

  it('offers an undo that could not be written again, in a toast of its own (#455)', async () => {
    const toasts = createToasts();
    const { hook, initial, files } = inbox({ toasts });
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'backlog' } }),
    );
    const { fs } = initial.ports;
    const write = fs.writeTextFile;
    fs.writeTextFile = async () => {
      fs.writeTextFile = write;
      throw new Error('The disk is full.');
    };

    await pressUndo(toasts);
    await waitFor(() => expect(hook.result.current.problem).toMatch(/disk is full/));
    expect(toasts.store.getState().toasts.map((toast) => toast.message)).toEqual([
      'Clarified “Call the bank”.',
    ]);

    await pressUndo(toasts);
    await waitFor(() => expect(files.get(CALL)).toBe(CAPTURED));
  });

  it('says nothing for a clarification that failed', async () => {
    const toasts = createToasts();
    const { hook } = inbox({ toasts });
    await act(() =>
      hook.result.current.clarify({
        path: createVaultPath('Inbox/Gone.md'),
        clarification: { status: 'backlog' },
      }),
    );
    expect(toasts.store.getState().toasts).toEqual([]);
  });
});
