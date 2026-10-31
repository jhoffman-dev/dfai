// @vitest-environment jsdom
/**
 * #217: a clarified row leaves the Inbox at once and is written behind the
 * page, so the next row can be worked straight away. A write that fails
 * brings its row back with why, to try again; Undo still takes the last one
 * back; and the window's close waits for what is still being written.
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
  type WindowClosingPort,
} from '@dfai/application';
import { createVaultPath, INBOX_QUERY_COLUMNS, TASK_TYPE_FILE, type VaultPath } from '@dfai/domain';
import { useInbox, type InboxOptions } from './use-inbox.ts';

const CALL = createVaultPath('Inbox/Call Mara Quill.md');
const PAY = createVaultPath('Inbox/Pay Tobias Fenn.md');
const CAPTURED = '---\ntype: task\nstatus: inbox\n---\n\nAbout Larkspur Payroll.\n';

/** A promise and the function that settles it, to hold a write mid-way. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

function inbox() {
  const memory = memoryVault({ [CALL]: CAPTURED, [PAY]: CAPTURED });
  // What the index lists: every note still waiting, as of the last refresh.
  let listed = [CALL, PAY];
  let held: Promise<void> | null = null;
  let failing: string | null = null;
  const written: string[] = [];
  const ports: ArchivePorts = {
    fs: fakeVaultFs({
      ...memory.fs,
      writeTextFile: async (write) => {
        if (held !== null) await held;
        if (failing !== null) throw new Error(failing);
        written.push(write.path);
        return memory.fs.writeTextFile(write);
      },
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      query: async () => ({
        columns: [...INBOX_QUERY_COLUMNS],
        rows: listed.map((at) => [at, at, 'task', 0, null, null, 'inbox']),
        truncated: false,
      }),
    }),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
  const closes: (() => Promise<void>)[] = [];
  const closing: WindowClosingPort = {
    beforeClose: async (task) => {
      closes.push(task);
      return () => {};
    },
  };
  const onSettled = vi.fn();
  const initial: InboxOptions = {
    ports,
    notePaths: [CALL, PAY],
    vaultKey: '/vaults/larkspur',
    types: [TASK_TYPE_FILE.type],
    clock: { today: () => '2026-10-14' },
    indexKey: 'ready:1',
    open: true,
    onSettled,
    activity: recordingActivity(),
    closing,
  };
  const hook = renderHook((options: InboxOptions) => useInbox(options), { initialProps: initial });
  const shown = () => hook.result.current.contents?.items.map((item) => item.path) ?? null;
  return {
    hook,
    files: memory.files,
    written,
    onSettled,
    closes,
    shown,
    /** What the index will list from the next read on, with nothing said yet. */
    list: (still: readonly (typeof CALL)[]) => {
      listed = [...still];
    },
    /** The index catches up: it lists only these, and says so with a new key. */
    refresh: (still: readonly (typeof CALL)[], indexKey: string) => {
      listed = [...still];
      hook.rerender({ ...initial, indexKey });
    },
    hold: () => {
      const writes = gate();
      held = writes.opened;
      return () => {
        held = null;
        writes.open();
      };
    },
    fail: (reason: string | null) => {
      failing = reason;
    },
  };
}

describe('useInbox — a clarified row leaves at once (#217)', () => {
  it('takes the row off the list before its write is done, and the total with it', async () => {
    const { hook, shown, hold, files } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    const release = hold();

    let written: Promise<boolean> = Promise.resolve(false);
    act(() => {
      written = hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action' },
      });
    });

    expect(shown()).toEqual([PAY]);
    expect(hook.result.current.contents?.total).toBe(1);
    expect(hook.result.current.busy).toBe(false);
    expect(files.get(CALL)).toBe(CAPTURED);

    release();
    await act(async () => {
      expect(await written).toBe(true);
    });
    expect(files.get(CALL)).toContain('status: next-action');
  });

  it('takes the next row while the last is still being written, and writes both in turn', async () => {
    const { hook, shown, hold, written, onSettled } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    const release = hold();

    const outcomes: Promise<boolean>[] = [];
    act(() => {
      outcomes.push(
        hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } }),
      );
    });
    act(() => {
      outcomes.push(
        hook.result.current.clarify({ path: PAY, clarification: { status: 'someday' } }),
      );
    });
    expect(shown()).toEqual([]);

    release();
    await act(async () => {
      expect(await Promise.all(outcomes)).toEqual([true, true]);
    });
    expect(written).toEqual([CALL, PAY]);
    // Read again once for the run of writes, not once for each.
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it('keeps a written row off until the index has caught up, then shows what it says', async () => {
    const { hook, shown, refresh } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } }),
    );
    expect(shown()).toEqual([PAY]);

    // An index that has moved on, and lists the row no more.
    refresh([PAY], 'ready:2');
    await waitFor(() => expect(shown()).toEqual([PAY]));

    // Listed again by an index that has moved on since — put back by hand, say — it is shown.
    refresh([CALL, PAY], 'ready:3');
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
  });
});

describe('useInbox — a write that fails (#217)', () => {
  it('brings the row back with why, records nothing lost, and can be tried again', async () => {
    const { hook, shown, hold, fail, files } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    const release = hold();
    fail('the disk is full');

    let outcome: Promise<boolean> = Promise.resolve(true);
    act(() => {
      outcome = hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action' },
      });
    });
    expect(shown()).toEqual([PAY]);

    release();
    await act(async () => {
      expect(await outcome).toBe(false);
    });
    expect(shown()).toEqual([CALL, PAY]);
    expect(hook.result.current.refusals).toEqual([{ path: CALL, reason: 'the disk is full' }]);
    expect(files.get(CALL)).toBe(CAPTURED);

    fail(null);
    await act(async () => {
      expect(
        await hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } }),
      ).toBe(true);
    });
    expect(shown()).toEqual([PAY]);
    expect(hook.result.current.refusals).toEqual([]);
    expect(files.get(CALL)).toContain('status: next-action');
  });
});

describe('useInbox — Undo, with writes behind the page (#217)', () => {
  it('takes the last one back once its write is done, and only once however often it is pressed', async () => {
    const { hook, shown, files, onSettled } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } }),
    );
    expect(hook.result.current.lastAction).toEqual({ title: 'Call Mara Quill' });

    let outcomes: boolean[] = [];
    await act(async () => {
      outcomes = await Promise.all([hook.result.current.undo(), hook.result.current.undo()]);
    });

    expect(outcomes).toEqual([true, false]);
    expect(files.get(CALL)).toBe(CAPTURED);
    expect(hook.result.current.problem).toBeNull();
    expect(hook.result.current.lastAction).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });
});

describe('useInbox — one triage key per row, in turn (#308)', () => {
  it('takes each row off as its key is pressed, writes only the status each key gave, and Undo takes the last back', async () => {
    const { hook, shown, hold, files } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    const release = hold();

    // W on the first row, then D on the next before the first is written: what the keys send, the status alone.
    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = hook.result.current.clarify({ path: CALL, clarification: { status: 'waiting' } });
    });
    expect(shown()).toEqual([PAY]);
    act(() => {
      second = hook.result.current.clarify({ path: PAY, clarification: { status: 'archive' } });
    });
    expect(shown()).toEqual([]);

    release();
    await act(async () => {
      expect(await Promise.all([first, second])).toEqual([true, true]);
    });
    // The status line changes and nothing else: no project, no line of the note moved.
    expect(files.get(CALL)).toBe(CAPTURED.replace('status: inbox', 'status: waiting'));
    expect(files.get(PAY)).toContain('status: archive');
    expect(files.get(PAY)).not.toContain('project:');
    expect(hook.result.current.lastAction).toEqual({ title: 'Pay Tobias Fenn' });

    await act(async () => {
      expect(await hook.result.current.undo()).toBe(true);
    });
    expect(files.get(PAY)).toBe(CAPTURED);
    expect(files.get(CALL)).toBe(CAPTURED.replace('status: inbox', 'status: waiting'));
  });
});

describe('useInbox — U takes the last back and says where it is listed (#109)', () => {
  it('resolves once the list holds the row again, not on a read begun before the index caught up', async () => {
    const { hook, shown, files, onSettled, refresh, list } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } }),
    );
    refresh([PAY], 'ready:2');
    await waitFor(() => expect(shown()).toEqual([PAY]));

    // The refresh after the undo's write is held: until it lands, the index still lists the row as gone.
    const caughtUp = gate();
    onSettled.mockImplementation(() => caughtUp.opened);
    let back: VaultPath | null | undefined;
    act(() => {
      void hook.result.current.takeBackLast().then((path) => {
        back = path;
      });
    });
    await waitFor(() => expect(files.get(CALL)).toBe(CAPTURED));
    // Reads the page makes meanwhile — begun before the index caught up — do not list it.
    refresh([PAY], 'ready:3');
    refresh([PAY], 'ready:4');
    refresh([PAY], 'ready:5');
    await waitFor(() => expect(shown()).toEqual([PAY]));
    expect(back).toBeUndefined();

    list([CALL, PAY]);
    await act(async () => caughtUp.open());
    await waitFor(() => expect(back).toBe(CALL));
    expect(shown()).toContain(CALL);
  });

  it('still resolves, to the row, when a read after the index caught up does not list it', async () => {
    const { hook, shown, files, refresh } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } }),
    );
    refresh([PAY], 'ready:2');
    await waitFor(() => expect(shown()).toEqual([PAY]));

    // Taken back, but listed nowhere the Inbox reads (filtered out, say): the page gives up on it itself.
    let back: VaultPath | null | undefined;
    act(() => {
      void hook.result.current.takeBackLast().then((path) => {
        back = path;
      });
    });
    await waitFor(() => expect(files.get(CALL)).toBe(CAPTURED));
    await waitFor(() => expect(back).toBe(CALL));
    expect(shown()).toEqual([PAY]);
  });
});

describe('useInbox — closing the window (#217)', () => {
  it('holds the close until what is being written is written', async () => {
    const { hook, shown, hold, closes, files } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    await waitFor(() => expect(closes).toHaveLength(1));
    const release = hold();
    act(() => {
      void hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } });
    });

    let closed = false;
    const closing = closes[0]?.().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await act(async () => {
      await closing;
    });
    expect(closed).toBe(true);
    expect(files.get(CALL)).toContain('status: next-action');
  });
});

const PROJECT = createVaultPath('Projects/Larkspur.md');
const SEND = createVaultPath('Inbox/Send Zoe Marlow the lease.md');
const TASK = (body: string) => `---\ntype: task\nstatus: inbox\n---\n\n${body}\n`;
const NO_EDITORS: ArchivePorts['editors'] = {
  state: () => 'closed',
  flush: async () => {},
  follow: () => {},
  abandon: () => {},
  reload: () => {},
};

/** An index that lists these, whatever has been written since. */
function listing(paths: readonly VaultPath[]): ArchivePorts['index'] {
  return fakeIndexPort({
    query: async () => ({
      columns: [...INBOX_QUERY_COLUMNS],
      rows: paths.map((at) => [at, at, 'task', 0, null, null, 'inbox']),
      truncated: false,
    }),
  });
}

/** The hook's options over `ports`, for the Larkspur vault as its tree was read before a burst of filings. */
function optionsFor(ports: ArchivePorts, notePaths: readonly VaultPath[]): InboxOptions {
  return {
    ports,
    notePaths,
    vaultKey: '/vaults/larkspur',
    types: [TASK_TYPE_FILE.type],
    clock: { today: () => '2026-10-15' },
    indexKey: 'ready:1',
    open: true,
    onSettled: vi.fn(),
    activity: recordingActivity(),
    closing: { beforeClose: async () => () => {} },
  };
}

/** A vault of Inbox tasks, whose write to `holdPath` waits until released; the tree is read again only when the test says. */
function burst(files: Record<string, string>, holdPath: VaultPath | null = null) {
  const memory = memoryVault(files);
  const held = gate();
  const ports: ArchivePorts = {
    fs: fakeVaultFs({
      ...memory.fs,
      // The host's: a note that is not there is skipped.
      readNotes: async (paths) =>
        paths.flatMap((path) => {
          const text = memory.files.get(path);
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        }),
      writeTextFile: async (write) => {
        if (write.path === holdPath) await held.opened;
        return memory.fs.writeTextFile(write);
      },
    }),
    markdown: fakeMarkdown(),
    index: listing([CALL, PAY, SEND]),
    editors: NO_EDITORS,
  };
  const options = optionsFor(ports, [...memory.files.keys()].map(createVaultPath));
  const hook = renderHook((given: InboxOptions) => useInbox(given), { initialProps: options });
  return { hook, files: memory.files, release: held.open };
}

const FILED_PAY = 'Tasks/2026/10/Pay Tobias Fenn.md';

describe('useInbox — a filing taken back while the queue is busy (#217)', () => {
  const files = {
    [PROJECT]: '---\ntype: project\n---\n',
    [CALL]: TASK('Ask about [[Inbox/Pay Tobias Fenn]] first.'),
    [PAY]: TASK('Pay the invoice.'),
    [SEND]: TASK('Send it.'),
  };

  it('re-points the path link one Inbox note holds to another filed', async () => {
    const { hook, files: vault } = burst(files);
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(3));
    await act(() =>
      hook.result.current.clarify({
        path: PAY,
        clarification: { status: 'next-action', project: PROJECT },
      }),
    );
    expect(vault.get(CALL)).toContain('[[Tasks/2026/10/Pay Tobias Fenn]]');
  });

  it('knows the note is back where it was, so a filing after re-points the link it holds', async () => {
    const { hook, files: vault, release } = burst(files, SEND);
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(3));

    await act(() =>
      hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action', project: PROJECT },
      }),
    );
    expect(vault.has(CALL)).toBe(false);

    // The next row is being written (held), so the queue does not drain and the tree is not re-read.
    const outcomes: Promise<boolean>[] = [];
    act(() => {
      outcomes.push(
        hook.result.current.clarify({ path: SEND, clarification: { status: 'someday' } }),
      );
    });
    // Undo Call, then file Pay — both queued behind Send.
    act(() => {
      outcomes.push(hook.result.current.undo());
    });
    act(() => {
      outcomes.push(
        hook.result.current.clarify({
          path: PAY,
          clarification: { status: 'next-action', project: PROJECT },
        }),
      );
    });
    release();
    await act(async () => {
      expect(await Promise.all(outcomes)).toEqual([true, true, true]);
    });

    expect(vault.has(CALL)).toBe(true);
    expect(vault.has(FILED_PAY)).toBe(true);
    expect(vault.get(CALL)).toContain('[[Tasks/2026/10/Pay Tobias Fenn]]');
  });

  it('knows where a filing that failed after its move left the note', async () => {
    const FILED_CALL = createVaultPath('Tasks/2026/10/Call Mara Quill.md');
    const memory = memoryVault(files);
    let writesOfFiled = 0;
    const ports: ArchivePorts = {
      fs: fakeVaultFs({
        ...memory.fs,
        readNotes: async (paths) =>
          paths.flatMap((path) => {
            const text = memory.files.get(path);
            return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
          }),
        // Moved, the filed note cannot be stamped where it landed: the filing fails after its move.
        writeTextFile: async (write) => {
          if (write.path === FILED_CALL && (writesOfFiled += 1) === 1) {
            throw new Error('the disk stopped answering');
          }
          return memory.fs.writeTextFile(write);
        },
      }),
      markdown: fakeMarkdown(),
      index: listing([CALL, PAY, SEND]),
      editors: NO_EDITORS,
    };
    const show = vi.fn<NonNullable<InboxOptions['toasts']>['show']>(() => 1);
    const options = {
      ...optionsFor(ports, [...memory.files.keys()].map(createVaultPath)),
      toasts: { show },
    };
    const hook = renderHook((given: InboxOptions) => useInbox(given), { initialProps: options });
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(3));

    const outcomes: Promise<boolean>[] = [];
    for (const path of [CALL, PAY]) {
      act(() => {
        outcomes.push(
          hook.result.current.clarify({
            path,
            clarification: { status: 'next-action', project: PROJECT },
          }),
        );
      });
    }
    await act(async () => {
      expect(await Promise.all(outcomes)).toEqual([false, true]);
    });

    expect(memory.files.has(FILED_CALL)).toBe(true);
    // Call's link to Pay followed Pay: the filing of Pay knew Call was filed.
    expect(memory.files.get(FILED_CALL)).toContain('[[Tasks/2026/10/Pay Tobias Fenn]]');
    // It moved a note, so the tree and the index are read again.
    expect(options.onSettled).toHaveBeenCalledOnce();
    // Said on the row where it is now, and offered to be taken back (#225, PR #612).
    expect(hook.result.current.refusals).toEqual([
      { path: FILED_CALL, reason: expect.stringMatching(/the disk stopped answering/) },
    ]);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Clarified “Call Mara Quill”.',
        onUndo: expect.any(Function),
      }),
    );
  });
});

describe('useInbox — failures in the middle of a burst (#217)', () => {
  function failing(paths: readonly VaultPath[]) {
    const memory = memoryVault({ [CALL]: TASK('a'), [PAY]: TASK('b'), [SEND]: TASK('c') });
    const ports: ArchivePorts = {
      fs: fakeVaultFs({
        ...memory.fs,
        writeTextFile: async (write) => {
          if (paths.includes(write.path)) throw new Error(`${write.path}: the disk is full`);
          return memory.fs.writeTextFile(write);
        },
      }),
      markdown: fakeMarkdown(),
      index: listing([CALL, PAY, SEND]),
      editors: NO_EDITORS,
    };
    const hook = renderHook((given: InboxOptions) => useInbox(given), {
      initialProps: optionsFor(ports, [CALL, PAY, SEND]),
    });
    const fileAll = async (all: readonly VaultPath[]) => {
      const outcomes: Promise<boolean>[] = [];
      for (const path of all) {
        act(() => {
          outcomes.push(
            hook.result.current.clarify({ path, clarification: { status: 'next-action' } }),
          );
        });
      }
      let done: boolean[] = [];
      await act(async () => {
        done = await Promise.all(outcomes);
      });
      return done;
    };
    return { hook, fileAll, paths };
  }

  it('brings the row that failed back still saying why, after the rows behind it are written', async () => {
    const { hook, fileAll } = failing([PAY]);
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(3));

    expect(await fileAll([CALL, PAY, SEND])).toEqual([true, false, true]);

    expect(hook.result.current.contents?.items.map((item) => item.path)).toEqual([PAY]);
    expect(hook.result.current.refusals).toEqual([
      { path: PAY, reason: `${PAY}: the disk is full` },
    ]);
  });

  it('keeps each failed row’s reason until that row is clarified again', async () => {
    const { hook, fileAll, paths } = failing([CALL, SEND]);
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(3));

    expect(await fileAll([CALL, PAY, SEND])).toEqual([false, true, false]);
    expect(hook.result.current.refusals).toEqual([
      { path: CALL, reason: `${CALL}: the disk is full` },
      { path: SEND, reason: `${SEND}: the disk is full` },
    ]);

    (paths as VaultPath[]).length = 0;
    expect(await fileAll([SEND])).toEqual([true]);
    expect(hook.result.current.refusals).toEqual([
      { path: CALL, reason: `${CALL}: the disk is full` },
    ]);
  });
});

describe('useInbox — leaving a vault with filings still queued (#217)', () => {
  it('settles what a switch waits for only once the filings queued are written', async () => {
    // The host as boundToVault makes it: a write bound to a vault that is no longer open is refused (R14-01).
    let openVault = '/vaults/larkspur';
    const memory = memoryVault({ [CALL]: TASK('a'), [PAY]: TASK('b') });
    const held = gate();
    const ports: ArchivePorts = {
      fs: fakeVaultFs({
        ...memory.fs,
        writeTextFile: async (write) => {
          await held.opened;
          if (openVault !== '/vaults/larkspur') throw new Error('another vault is open');
          return memory.fs.writeTextFile(write);
        },
      }),
      markdown: fakeMarkdown(),
      index: listing([CALL, PAY]),
      editors: NO_EDITORS,
    };
    const first = optionsFor(ports, [CALL, PAY]);
    const hook = renderHook((given: InboxOptions) => useInbox(given), { initialProps: first });
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(2));

    const outcomes: Promise<boolean>[] = [];
    for (const path of [CALL, PAY]) {
      act(() => {
        outcomes.push(
          hook.result.current.clarify({ path, clarification: { status: 'next-action' } }),
        );
      });
    }
    expect(hook.result.current.contents?.items).toHaveLength(0);

    // The person opens another vault: the switch (app.tsx's leaveVault) waits for this first.
    let left = false;
    const leaving = hook.result.current.written().then(() => {
      left = true;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(left).toBe(false);
    held.open();
    await act(async () => {
      await leaving;
    });
    openVault = '/vaults/quill';
    hook.rerender({ ...first, vaultKey: '/vaults/quill', notePaths: [], indexKey: 'working' });
    await act(async () => {
      expect(await Promise.all(outcomes)).toEqual([true, true]);
    });

    expect(memory.files.get(CALL)).toContain('status: next-action');
    expect(memory.files.get(PAY)).toContain('status: next-action');
  });

  it('files a note queued before a switch against the notes of the vault it was asked in', async () => {
    const memory = memoryVault({ [PROJECT]: '---\ntype: project\n---\n', [CALL]: TASK('a') });
    const held = gate();
    const ports: ArchivePorts = {
      // Bound to Larkspur, as the ports a write was asked through are.
      fs: fakeVaultFs({
        ...memory.fs,
        writeTextFile: async (write) => {
          await held.opened;
          return memory.fs.writeTextFile(write);
        },
      }),
      markdown: fakeMarkdown(),
      index: listing([CALL]),
      editors: NO_EDITORS,
    };
    const first = optionsFor(ports, [PROJECT, CALL]);
    const hook = renderHook((given: InboxOptions) => useInbox(given), { initialProps: first });
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(1));

    let outcome: Promise<boolean> = Promise.resolve(false);
    act(() => {
      outcome = hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action', project: PROJECT },
      });
    });
    // Another vault opens, with notes of its own, before the filing is written.
    hook.rerender({
      ...first,
      vaultKey: '/vaults/quill',
      notePaths: [createVaultPath('Notes/Quill ledger.md')],
      indexKey: 'working',
    });
    held.open();
    await act(async () => {
      expect(await outcome).toBe(true);
    });

    expect(memory.files.has('Tasks/2026/10/Call Mara Quill.md')).toBe(true);
  });
});

describe('useInbox — an index sync begun before a filing landed (#217)', () => {
  /** A vault of three Inbox tasks whose index, until the page's own refresh lands, is what a sync read before the filing. */
  function syncing(holdPath: VaultPath) {
    const memory = memoryVault({
      [PROJECT]: '---\ntype: project\n---\n',
      [CALL]: TASK('a'),
      [PAY]: TASK('b'),
      [SEND]: TASK('c'),
    });
    const held = gate();
    const refreshed = gate();
    const ports: ArchivePorts = {
      fs: fakeVaultFs({
        ...memory.fs,
        readNotes: async () => [],
        writeTextFile: async (write) => {
          if (write.path === holdPath) await held.opened;
          return memory.fs.writeTextFile(write);
        },
      }),
      markdown: fakeMarkdown(),
      index: listing([CALL, PAY, SEND]),
      editors: NO_EDITORS,
    };
    // As the app's: the refresh it asks for settles once the index holds what was written.
    const first: InboxOptions = {
      ...optionsFor(ports, [PROJECT, CALL, PAY, SEND]),
      onSettled: () => refreshed.opened.then(() => true),
    };
    const hook = renderHook((given: InboxOptions) => useInbox(given), { initialProps: first });
    const shown = () => hook.result.current.contents?.items.map((item) => item.path) ?? [];
    const fileCall = () =>
      hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action', project: PROJECT },
      });
    return { hook, first, shown, fileCall, memory, release: held.open, refreshed: refreshed.open };
  }

  it('keeps the filed row off what that sync found, once the queue has drained', async () => {
    const { hook, first, shown, fileCall, memory, release, refreshed } = syncing(SEND);
    await waitFor(() => expect(shown()).toEqual([CALL, PAY, SEND]));

    // A watcher-triggered sync starts (the index says "working") and reads the Inbox as it is now.
    hook.rerender({ ...first, indexKey: 'working' });
    // Call is filed and its write lands while that sync runs; Send is filed behind it, still being written.
    await act(async () => {
      void fileCall();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(memory.files.has(CALL)).toBe(false);
    act(() => {
      void hook.result.current.clarify({ path: SEND, clarification: { status: 'someday' } });
    });
    // The sync finishes: it read the Inbox before Call moved, so it still lists Call.
    hook.rerender({ ...first, indexKey: 'ready:2' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(shown()).toEqual([PAY]);
    release();
    refreshed();
  });

  it('keeps the filed row off what that sync found while the row behind it is still being written', async () => {
    const { hook, first, shown, fileCall, memory, release, refreshed } = syncing(SEND);
    await waitFor(() => expect(shown()).toEqual([CALL, PAY, SEND]));

    hook.rerender({ ...first, indexKey: 'working' });
    // Send is asked for before Call's write lands, so the queue never drains between them.
    let filed: Promise<boolean> = Promise.resolve(false);
    act(() => {
      filed = fileCall();
      void hook.result.current.clarify({ path: SEND, clarification: { status: 'someday' } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(memory.files.has(CALL)).toBe(false);

    hook.rerender({ ...first, indexKey: 'ready:2' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(shown()).toEqual([PAY]);

    // Send lands and the page's own refresh is asked for: once it lands, what the index says is shown.
    release();
    refreshed();
    await act(async () => {
      expect(await filed).toBe(true);
    });
    hook.rerender({ ...first, indexKey: 'ready:3' });
    await waitFor(() => expect(shown()).toEqual([CALL, PAY, SEND]));
  });
});

describe('useInbox — a filing by link that moves nothing (#214, #217)', () => {
  const STANDUP = createVaultPath('Meetings/2026/10/Standup.md');
  const files = {
    [PROJECT]: '---\ntype: project\n---\n',
    [STANDUP]: '---\ntype: meeting\nstatus: inbox\n---\n\nSprint notes.\n',
    [PAY]: TASK('Pay the invoice.'),
  };

  function linkedBurst() {
    const memory = memoryVault(files);
    const ports: ArchivePorts = {
      fs: fakeVaultFs({
        ...memory.fs,
        readNotes: async (paths) =>
          paths.flatMap((path) => {
            const text = memory.files.get(path);
            return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
          }),
      }),
      markdown: fakeMarkdown(),
      index: listing([STANDUP, PAY]),
      editors: NO_EDITORS,
    };
    const options = optionsFor(ports, [...memory.files.keys()].map(createVaultPath));
    const hook = renderHook((given: InboxOptions) => useInbox(given), { initialProps: options });
    return { hook, options, vault: memory.files };
  }

  it('takes the row off, leaves the note where it is, and reads the index again', async () => {
    const { hook, options, vault } = linkedBurst();
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(2));

    await act(async () => {
      expect(
        await hook.result.current.clarify({
          path: STANDUP,
          clarification: { project: PROJECT },
        }),
      ).toBe(true);
    });

    expect(vault.has(STANDUP)).toBe(true);
    expect(vault.get(STANDUP)).toContain('[[Larkspur]]');
    expect(hook.result.current.contents?.items.map((item) => item.path)).toEqual([PAY]);
    expect(options.onSettled).toHaveBeenCalledOnce();
    expect(hook.result.current.refusals).toEqual([]);
  });

  it('files the next Inbox note against the same tree, then takes the first back where it stood', async () => {
    const { hook, vault } = linkedBurst();
    await waitFor(() => expect(hook.result.current.contents?.items).toHaveLength(2));

    await act(async () => {
      await hook.result.current.clarify({
        path: STANDUP,
        clarification: { project: PROJECT },
      });
    });
    expect(hook.result.current.lastAction).toEqual({ title: 'Standup' });
    await act(async () => {
      expect(await hook.result.current.undo()).toBe(true);
    });

    expect(vault.get(STANDUP)).toBe(files[STANDUP]);
    await act(async () => {
      expect(
        await hook.result.current.clarify({
          path: PAY,
          clarification: { project: PROJECT },
        }),
      ).toBe(true);
    });
    expect(vault.has(PAY)).toBe(false);
    expect(vault.get(STANDUP)).toBe(files[STANDUP]);
  });
});
