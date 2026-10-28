import { splitFrontmatter, taskDeferral, TASK_KEYS } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { setNoteProperties, type PropertyChanges } from '../query/set-property.ts';
import { archiveTaskChange } from '../review/review-actions.ts';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { ChangedSinceError, changeUndoably, whileAsRead } from './today-actions.ts';

/** #111: the Today page's actions, written through the one write and taken back. */
const PATH = 'Tasks/Water the beds.md';
const TODAY = '2026-10-13';

function vaultWith(text: string) {
  const memory = memoryVault({ [PATH]: text });
  const markdown = fakeMarkdown();
  // Stamped anew by each write, as a file is: the memory vault's own stamp never moves.
  let stamp = 1;
  const fs = fakeVaultFs({
    ...memory.fs,
    readTextFile: async (path) => ({ ...(await memory.fs.readTextFile(path)), modified: stamp }),
    writeTextFile: async (written) => {
      if (written.expectedModified !== undefined && written.expectedModified !== stamp) {
        throw new Error('the file changed underneath');
      }
      stamp += 1;
      return memory.fs.writeTextFile({ ...written, expectedModified: 1 });
    },
  });
  const write = (values: PropertyChanges, ifModified?: number) =>
    setNoteProperties({
      fs,
      markdown,
      path: PATH,
      values,
      today: TODAY,
      ...(ifModified !== undefined && { ifModified }),
    });
  const contents = () => memory.files.get(PATH) ?? '';
  const properties = () =>
    markdown.frontmatterProperties(splitFrontmatter(contents()).frontmatter ?? '');
  /** Makes a change as the page does, answering with its undo. */
  const change = async (values: PropertyChanges) => {
    const made = await changeUndoably({
      fs,
      markdown,
      path: PATH,
      write: (readAt) => write(values, readAt),
    });
    if (made.undo === null) throw new Error('no undo was offered');
    return made.undo;
  };
  return { memory, fs, markdown, write, change, text: contents, properties };
}

const NEXT = '---\ntype: task\nstatus: next-action\n---\n\nBody.\n';
const defer = (days: number) => taskDeferral({ today: TODAY, days }) ?? {};

describe('changeUndoably', () => {
  it('takes a deferral back, leaving the file as it was', async () => {
    const vault = vaultWith(NEXT);
    const undo = await vault.change(defer(1));
    expect(vault.properties()).toMatchObject({ defer: '2026-10-14' });
    await vault.write(undo);
    expect(vault.text()).toBe(NEXT);
  });

  it('puts back the day a task was deferred to before', async () => {
    const vault = vaultWith('---\ntype: task\nstatus: next-action\ndefer: 2026-10-13\n---\n');
    const undo = await vault.change(defer(7));
    expect(vault.properties()).toMatchObject({ defer: '2026-10-20' });
    await vault.write(undo);
    expect(vault.properties()).toMatchObject({ defer: '2026-10-13' });
  });

  it('counts a change as made, with no undo, when the task cannot be read back afterwards', async () => {
    const vault = vaultWith(NEXT);
    let reads = 0;
    const fs = {
      readTextFile: (path: Parameters<typeof vault.fs.readTextFile>[0]) => {
        reads += 1;
        return reads === 2
          ? Promise.reject(new Error('The disk is busy.'))
          : vault.fs.readTextFile(path);
      },
    };
    const made = await changeUndoably({
      fs,
      markdown: vault.markdown,
      path: PATH,
      write: () => vault.write(defer(1)),
    });
    expect(made.undo).toBeNull();
    expect(made.was).toEqual({ status: 'next-action', due: null, defer: null, focus: null });
    expect(vault.properties()).toMatchObject({ defer: '2026-10-14' });
  });

  it('says what the task was before the change', async () => {
    const vault = vaultWith('---\ntype: task\nstatus: in-progress\ndue: 2026-10-13\n---\n');
    const { was } = await changeUndoably({
      fs: vault.fs,
      markdown: vault.markdown,
      path: PATH,
      write: (readAt) => vault.write(defer(1), readAt),
    });
    expect(was).toEqual({ status: 'in-progress', due: '2026-10-13', defer: null, focus: null });
  });

  it('takes a move back to the status the task held', async () => {
    const vault = vaultWith(NEXT);
    const undo = await vault.change({ [TASK_KEYS.status]: 'someday' });
    expect(vault.properties()).toMatchObject({ status: 'someday' });
    await vault.write(undo);
    expect(vault.text()).toBe(NEXT);
  });

  it('unfinishes a ticked task: its status back, and the day the rules gave it gone', async () => {
    const vault = vaultWith(NEXT);
    const undo = await vault.change(archiveTaskChange());
    expect(vault.properties()).toMatchObject({ status: 'archive', completed: TODAY });
    await vault.write(undo);
    expect(vault.properties()).toEqual({ type: 'task', status: 'next-action' });
  });

  it('keeps a day the task was already finished on, which the task rules would take from a reopened task', async () => {
    const held = '---\ntype: task\nstatus: next-action\ncompleted: 2026-09-01\n---\n\nBody.\n';
    const vault = vaultWith(held);
    const undo = await vault.change(archiveTaskChange());
    expect(vault.properties()).toMatchObject({ status: 'archive', completed: '2026-09-01' });
    await vault.write(undo);
    expect(vault.text()).toBe(held);
  });

  it('rolls a repeating task back, taking out the key the roll added', async () => {
    const repeating =
      '---\ntype: task\nstatus: in-progress\ndue: 2026-10-13\nrecurrence: every week\n---\n\nBody.\n';
    const vault = vaultWith(repeating);
    const undo = await vault.change(archiveTaskChange());
    expect(vault.properties()).toMatchObject({
      status: 'next-action',
      due: '2026-10-20',
      lastCompleted: '2026-10-13',
    });
    await vault.write(undo);
    expect(vault.text()).toBe(repeating);
  });

  it('refuses to undo once the task says something else, and writes nothing', async () => {
    const vault = vaultWith(NEXT);
    const undo = await vault.change({ [TASK_KEYS.status]: 'someday' });
    await vault.write({ [TASK_KEYS.status]: 'backlog' });
    const edited = vault.text();
    await expect(vault.write(undo)).rejects.toThrow(ChangedSinceError);
    expect(vault.text()).toBe(edited);
  });

  it('still undoes when only another key has changed since', async () => {
    const vault = vaultWith(NEXT);
    const undo = await vault.change({ [TASK_KEYS.status]: 'someday' });
    await vault.write({ [TASK_KEYS.due]: '2026-11-01' });
    await vault.write(undo);
    expect(vault.properties()).toMatchObject({ status: 'next-action', due: '2026-11-01' });
  });

  it('passes on a refusal, and a missing task, with nothing written', async () => {
    const vault = vaultWith(NEXT);
    const stale = { status: 'someday', due: null, defer: null, focus: null } as const;
    const refused = whileAsRead({ values: { [TASK_KEYS.status]: 'waiting' }, row: stale });
    await expect(vault.change(refused)).rejects.toThrow(ChangedSinceError);
    expect(vault.text()).toBe(NEXT);
    await expect(
      changeUndoably({
        fs: vault.fs,
        markdown: vault.markdown,
        path: 'Tasks/Gone.md',
        write: () => Promise.reject(new Error('never reached')),
      }),
    ).rejects.not.toThrow('never reached');
  });

  it('hands the write the stamp it read the task at, so a file that moved on in between is refused', async () => {
    const vault = vaultWith(NEXT);
    const slipped = changeUndoably({
      fs: vault.fs,
      markdown: vault.markdown,
      path: PATH,
      write: async (readAt) => {
        // Another writer gets in between the look and the write.
        await vault.write({ [TASK_KEYS.due]: '2026-11-01' });
        await vault.write(defer(1), readAt);
      },
    });
    await expect(slipped).rejects.toThrow(NoteChangedError);
    expect(vault.properties()).not.toHaveProperty('defer');
  });
});

describe('whileAsRead', () => {
  const row = { status: 'next-action', due: '2026-10-13', defer: null, focus: null } as const;
  const DUE = '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\n---\n';

  it('makes the change while the task says what the row read', async () => {
    const vault = vaultWith(DUE);
    await vault.write(whileAsRead({ values: defer(1), row }));
    expect(vault.properties()).toMatchObject({ defer: '2026-10-14' });
  });

  it.each([
    ['its status', '---\ntype: task\nstatus: archive\ndue: 2026-10-13\n---\n'],
    ['its due day', '---\ntype: task\nstatus: next-action\ndue: 2026-10-20\n---\n'],
    [
      'its defer day',
      '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\ndefer: 2026-10-30\n---\n',
    ],
  ])('refuses once %s is no longer what the row read, and writes nothing', async (_what, text) => {
    const vault = vaultWith(text);
    await expect(vault.write(whileAsRead({ values: archiveTaskChange(), row }))).rejects.toThrow(
      ChangedSinceError,
    );
    expect(vault.text()).toBe(text);
  });

  it('is untroubled by a change the row never showed', async () => {
    const vault = vaultWith(
      '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\nestimate: 30\n---\n',
    );
    await vault.write(whileAsRead({ values: defer(1), row }));
    expect(vault.properties()).toMatchObject({ defer: '2026-10-14' });
  });
});
