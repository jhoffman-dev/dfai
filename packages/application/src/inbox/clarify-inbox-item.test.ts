/**
 * Clarifying an Inbox row (#112), over a vault held in memory that answers
 * the way the host does. What is asserted is what each note says and where it
 * is afterwards — and that a refusal leaves both as they were.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type Clarification, type VaultPath } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { FrontmatterRefusedError } from '../notes/frontmatter-refused-error.ts';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { UnsavedTypingError } from '../vault/update-links.ts';
import {
  clarifiedAnything,
  clarifyInboxItem,
  ClarifyRefusedError,
  undoClarifyInboxItem,
} from './clarify-inbox-item.ts';

const path = (raw: string): VaultPath => createVaultPath(raw);
const TODAY = '2026-10-11';

const PROJECT = '---\ntype: project\nstatus: active\n---\n\n# Atlas\n';
const PERSON = '---\ntype: person\n---\n\n# Mara Quill\n';
const CAPTURED =
  '---\ntype: task\nstatus: inbox\n---\n\nAbout the loan.\n\n- [ ] find the letter\n';
const CALL = 'Inbox/Call the bank.md';

function vault(
  files: Record<string, string>,
  {
    pane = 'closed',
    failingMove,
    editedAfterRead,
    frontmatterRefusal,
  }: {
    pane?: 'closed' | 'clean' | 'dirty';
    failingMove?: string;
    /** A note another editor saves right after it is first read: its path. */
    editedAfterRead?: string;
    /** Why the frontmatter writer refuses every change, when it does. */
    frontmatterRefusal?: FrontmatterRefusedError;
  } = {},
) {
  const memory = memoryVault(files);
  const writes: string[] = [];
  let edited = false;
  const reloaded: string[] = [];
  const flushed: string[] = [];
  let typing = pane;
  let failingWrite: string | null = null;
  const ports: ArchivePorts = {
    fs: fakeVaultFs({
      ...memory.fs,
      ...(failingMove !== undefined && {
        moveEntry: async () => {
          throw new Error(failingMove);
        },
      }),
      readTextFile: async (at) => {
        const read = await memory.fs.readTextFile(at);
        if (at !== editedAfterRead) return read;
        // Once edited, the disk's time has moved on: every later read says so.
        if (edited) return { ...read, modified: 2 };
        edited = true;
        memory.files.set(at, `${read.text}Typed in another editor.\n`);
        return read;
      },
      writeTextFile: async (write) => {
        if (failingWrite !== null) throw new Error(failingWrite);
        writes.push(write.path);
        return memory.fs.writeTextFile(write);
      },
    }),
    markdown: {
      ...fakeMarkdown(),
      ...(frontmatterRefusal !== undefined && {
        updateFrontmatter: () => {
          throw frontmatterRefusal;
        },
      }),
    },
    index: fakeIndexPort(),
    editors: {
      state: () => typing,
      flush: async (paths) => {
        flushed.push(...paths);
        typing = 'clean';
      },
      follow: () => {},
      abandon: () => {},
      reload: (at) => void reloaded.push(at),
    },
  };
  const notePaths = () => [...memory.files.keys()].map(path);
  const clarify = (at: string, clarification: Clarification, unsavedTyping?: 'save' | 'leave') =>
    clarifyInboxItem({
      ports,
      path: path(at),
      clarification,
      notePaths: notePaths(),
      today: TODAY,
      ...(unsavedTyping !== undefined && { unsavedTyping }),
    });
  const undo = (record: Parameters<typeof undoClarifyInboxItem>[0]['undo']) =>
    undoClarifyInboxItem({ ports, undo: record, notePaths: notePaths() });
  return {
    files: memory.files,
    failWrites: (reason: string | null) => void (failingWrite = reason),
    writes,
    reloaded,
    flushed,
    clarify,
    undo,
  };
}

const BASE = { 'Projects/Atlas.md': PROJECT, 'People/Mara Quill.md': PERSON, [CALL]: CAPTURED };

describe('clarifyInboxItem', () => {
  it('sets the status and files the task under its project: it moves to its home, linked, its text kept', async () => {
    const v = vault(BASE);

    const outcome = await v.clarify(CALL, {
      status: 'next-action',
      project: path('Projects/Atlas.md'),
    });

    expect(outcome).toMatchObject({
      path: 'Tasks/2026/10/Call the bank.md',
      movedFrom: CALL,
      failed: [],
    });
    expect(v.files.has(CALL)).toBe(false);
    expect(v.files.get('Tasks/2026/10/Call the bank.md')).toBe(
      '---\ntype: task\nstatus: next-action\nproject: [[Atlas]]\n---\n\nAbout the loan.\n\n- [ ] find the letter\n',
    );
  });

  it('writes Waiting and who it waits on in one save of the note', async () => {
    const v = vault(BASE);

    await v.clarify(CALL, { status: 'waiting', waitingOn: path('People/Mara Quill.md') });

    expect(v.writes).toEqual([CALL]);
    expect(v.files.get(CALL)).toBe(
      '---\ntype: task\nstatus: waiting\nwaiting_on: [[Mara Quill]]\n---\n\nAbout the loan.\n\n- [ ] find the letter\n',
    );
  });

  it('writes Waiting with nobody to wait on, asking for no one (#202)', async () => {
    const v = vault(BASE);

    await v.clarify(CALL, { status: 'waiting' });

    expect(v.writes).toEqual([CALL]);
    expect(v.files.get(CALL)).toBe(
      '---\ntype: task\nstatus: waiting\n---\n\nAbout the loan.\n\n- [ ] find the letter\n',
    );
  });

  it('gives a single action its status with no project, leaving it where it is', async () => {
    const v = vault(BASE);

    const outcome = await v.clarify(CALL, { status: 'someday', defer: '2026-11-01' });

    expect(outcome).toMatchObject({ path: CALL, movedFrom: null });
    expect(v.files.get(CALL)).toContain('status: someday\ndefer: 2026-11-01\n');
    expect(v.reloaded).toEqual([CALL]);
  });

  it('links a task that lives outside the Inbox folder to its project without moving it', async () => {
    const v = vault({
      ...BASE,
      'Tasks/Imported.md': '---\ntype: task\nstatus: inbox\n---\n\nFrom Notion.\n',
    });

    const outcome = await v.clarify('Tasks/Imported.md', {
      status: 'backlog',
      project: path('Projects/Atlas.md'),
    });

    expect(outcome.movedFrom).toBeNull();
    expect(v.writes).toEqual(['Tasks/Imported.md']);
    expect(v.files.get('Tasks/Imported.md')).toBe(
      '---\ntype: task\nstatus: backlog\nproject: [[Atlas]]\n---\n\nFrom Notion.\n',
    );
  });

  it('files a meeting, which takes no status, as Process does', async () => {
    const v = vault({
      ...BASE,
      'Inbox/Meetings/Standup.md': '---\ntype: meeting\n---\n\nNotes.\n',
    });

    const outcome = await v.clarify('Inbox/Meetings/Standup.md', {
      project: path('Projects/Atlas.md'),
    });

    expect(outcome.path).toBe('Meetings/2026/10/Standup.md');
    expect(v.files.get('Meetings/2026/10/Standup.md')).toContain('project: [[Atlas]]');
    await expect(
      v.clarify('Meetings/2026/10/Standup.md', { status: 'next-action' }),
    ).rejects.toThrow(/^Only a task is given a status/);
  });

  // #214: a meeting waits in its month's folder; filing it is the link, and it stays put.
  it('files a meeting waiting in its month’s folder by its link alone, leaving its path as it was', async () => {
    const meeting = 'Meetings/2026/10/2026-10-06 Standup.md';
    const v = vault({
      ...BASE,
      [meeting]: '---\ntype: meeting\natlas_import: meeting/v1\n---\n\nNotes.\n',
    });

    const outcome = await v.clarify(meeting, { project: path('Projects/Atlas.md') });

    expect(outcome).toMatchObject({ path: meeting, movedFrom: null, failed: [] });
    expect(v.files.get(meeting)).toBe(
      '---\ntype: meeting\natlas_import: meeting/v1\nproject: [[Atlas]]\n---\n\nNotes.\n',
    );
  });

  it('makes a plain note a task waiting in the Inbox', async () => {
    const v = vault({ ...BASE, 'Inbox/Idea.md': 'Just a thought.\n' });
    await v.clarify('Inbox/Idea.md', { asTask: true });
    expect(v.files.get('Inbox/Idea.md')).toBe(
      '---\ntype: task\nstatus: inbox\n---\nJust a thought.\n',
    );
  });

  it('refuses a project that cannot be filed under before anything is written', async () => {
    const v = vault(BASE);

    await expect(
      v.clarify(CALL, { status: 'next-action', project: path('People/Mara Quill.md') }),
    ).rejects.toThrow(new ClarifyRefusedError('Project links to a project or area, not a person'));

    expect(v.files.get(CALL)).toBe(CAPTURED);
    expect(v.writes).toEqual([]);
  });

  it('refuses in the writer’s own words when it gives a reason for the person (#284)', async () => {
    const reason =
      'This note\'s properties list "status" twice; fix it in the source before changing it.';
    const v = vault(BASE, {
      frontmatterRefusal: new FrontmatterRefusedError({ key: 'status', message: reason }),
    });

    await expect(v.clarify(CALL, { status: 'someday' })).rejects.toThrow(
      new ClarifyRefusedError(reason),
    );

    expect(v.files.get(CALL)).toBe(CAPTURED);
    expect(v.writes).toEqual([]);
  });

  it('refuses waiting on a note that is not a person, or is not there', async () => {
    const v = vault(BASE);

    await expect(
      v.clarify(CALL, { status: 'waiting', waitingOn: path('Projects/Atlas.md') }),
    ).rejects.toThrow(new ClarifyRefusedError('Waiting on links to a person, not a project'));
    await expect(
      v.clarify(CALL, { status: 'waiting', waitingOn: path('People/Nobody.md') }),
    ).rejects.toThrow(new ClarifyRefusedError('There is nobody to wait on at that path.'));

    expect(v.files.get(CALL)).toBe(CAPTURED);
  });

  it('finds the note, the project and the person however their paths were cased', async () => {
    const v = vault(BASE);

    const outcome = await v.clarify('inbox/call the bank.md', {
      status: 'waiting',
      waitingOn: path('people/mara quill.md'),
      project: path('projects/atlas.md'),
    });

    expect(outcome.path).toBe('Tasks/2026/10/Call the bank.md');
    expect(v.files.get(outcome.path)).toContain('waiting_on: [[Mara Quill]]');
  });

  it('refuses a note that is not there', async () => {
    const v = vault(BASE);
    await expect(v.clarify('Inbox/Gone.md', { status: 'backlog' })).rejects.toThrow(
      new ClarifyRefusedError('There is no note at that path.'),
    );
  });

  it('says so, with the status written, when the filing then fails', async () => {
    const v = vault(BASE, { failingMove: 'the disk is full' });

    const outcome = await v.clarify(CALL, {
      status: 'next-action',
      project: path('Projects/Atlas.md'),
    });

    expect(outcome.path).toBe(CALL);
    expect(outcome.failed).toEqual([{ path: CALL, reason: 'the disk is full' }]);
    expect(v.files.get(CALL)).toContain('status: next-action');
  });
});

describe('clarifyInboxItem — a note open in a pane', () => {
  it('writes the pane’s typing first when the app asks, then clarifies what it wrote', async () => {
    const v = vault(BASE, { pane: 'dirty' });
    await v.clarify(CALL, { status: 'backlog' });
    expect(v.flushed).toEqual([CALL]);
    expect(v.files.get(CALL)).toContain('status: backlog');
  });

  it('leaves a note with unsaved typing alone when another tool asks', async () => {
    const v = vault(BASE, { pane: 'dirty' });

    await expect(v.clarify(CALL, { status: 'backlog' }, 'leave')).rejects.toThrow(
      UnsavedTypingError,
    );

    expect(v.flushed).toEqual([]);
    expect(v.files.get(CALL)).toBe(CAPTURED);
  });
});

describe('undoClarifyInboxItem', () => {
  it('puts a filed task back where it was, saying what it said, byte for byte', async () => {
    const v = vault(BASE);
    const { undo } = await v.clarify(CALL, {
      status: 'waiting',
      waitingOn: path('People/Mara Quill.md'),
      project: path('Projects/Atlas.md'),
    });

    await v.undo(undo);

    expect(v.files.get(CALL)).toBe(CAPTURED);
    expect(v.files.has('Projects/Atlas/Call the bank.md')).toBe(false);
  });

  it('puts back the properties of a task that did not move', async () => {
    const v = vault(BASE);
    const { undo } = await v.clarify(CALL, { status: 'next-action', due: '2026-10-20' });
    await v.undo(undo);
    expect(v.files.get(CALL)).toBe(CAPTURED);
  });

  it('refuses, touching nothing, once the note was changed since', async () => {
    const v = vault(BASE);
    const { undo, path: landed } = await v.clarify(CALL, {
      status: 'next-action',
      project: path('Projects/Atlas.md'),
    });
    const edited = `${v.files.get(landed) ?? ''}\nA line added since.\n`;
    v.files.set(landed, edited);

    await expect(v.undo(undo)).rejects.toThrow(
      new ClarifyRefusedError('It was changed since, so it was left as it is.'),
    );

    expect(v.files.get(landed)).toBe(edited);
    expect(v.files.has(CALL)).toBe(false);
  });

  it('refuses when another note has taken its place in the Inbox, leaving the filed one filed', async () => {
    const v = vault(BASE);
    const { undo, path: landed } = await v.clarify(CALL, { project: path('Projects/Atlas.md') });
    const filed = v.files.get(landed);
    v.files.set(CALL, 'A newer capture of the same name.\n');

    await expect(v.undo(undo)).rejects.toThrow(
      /^Nothing was undone: another note has taken its place/,
    );

    expect(v.files.get(landed)).toBe(filed);
    expect(v.files.get(CALL)).toBe('A newer capture of the same name.\n');
  });

  it('refuses when the note is gone', async () => {
    const v = vault(BASE);
    const { undo } = await v.clarify(CALL, { status: 'backlog' });
    v.files.delete(CALL);
    await expect(v.undo(undo)).rejects.toThrow(/not there any more/);
  });
});

/** Review round on #112. */
describe('clarifyInboxItem — a note that changes underneath it', () => {
  it('fails as changed, keeping the edit, when another editor saved it after it was read', async () => {
    const v = vault(BASE, { editedAfterRead: CALL });
    await expect(v.clarify(CALL, { status: 'next-action' })).rejects.toBeInstanceOf(
      NoteChangedError,
    );
    expect(v.files.get(CALL)).toBe(`${CAPTURED}Typed in another editor.\n`);
    expect(v.writes).toEqual([]);
  });
});

describe('undoClarifyInboxItem — tried again', () => {
  it('finishes an undo that moved the note back and then could not write it', async () => {
    const v = vault(BASE);
    const { undo } = await v.clarify(CALL, { project: path('Projects/Atlas.md') });
    v.failWrites('the disk is full');
    await expect(v.undo(undo)).rejects.toThrow('the disk is full');
    // Moved back, still saying what clarifying wrote.
    expect(v.files.get(CALL)).toBe(undo.after);

    v.failWrites(null);
    await v.undo(undo);
    expect(v.files.get(CALL)).toBe(CAPTURED);
  });
});

describe('clarifiedAnything (#225)', () => {
  const at = createVaultPath('Inbox/Call the bank.md');
  const filed = createVaultPath('Tasks/2026/10/Call the bank.md');
  const text = '---\ntype: task\nstatus: inbox\n---\n';
  const undo = { from: at, to: at, before: text, after: text };

  it('is false when the note neither moved nor changed: a filing alone that failed', () => {
    expect(clarifiedAnything({ undo })).toBe(false);
  });

  it('is true once its properties were written, though it did not move', () => {
    expect(
      clarifiedAnything({ undo: { ...undo, after: text.replace('inbox', 'next-action') } }),
    ).toBe(true);
  });

  it('is true once it moved, though its text is the same', () => {
    expect(clarifiedAnything({ undo: { ...undo, to: filed } })).toBe(true);
  });
});
