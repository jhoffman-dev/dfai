/**
 * Making a task from a meeting's action item (#177, ADR-0036 "Linked both
 * ways"): the one way Accept and the meeting step make it. Over a vault held
 * in memory.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  linkTargets,
  resolveWikiLinkTarget,
  type MeetingIdentity,
} from '@dfai/domain';
import { MEETING_BODY } from '../testing/meeting-files.ts';
import {
  jsonLinesNote,
  proposalVault,
  vaultPath,
  type ProposalVault,
} from '../testing/proposal-vault.ts';
import {
  makeTaskFromMeeting,
  undoMadeTask,
  type MeetingItemTask,
} from './make-task-from-meeting.ts';

const TODAY = '2026-10-06';
const MEETING = 'Projects/Ledger/2026-10-06 Standup.md';
const TASK = 'Tasks/2026/10/Send Mara the payroll file.md';
const IDENTITY: MeetingIdentity = { provider: 'gemini', externalId: 'gemini-7f3a9c21' };
const ITEM_KEY = 'gemini:gemini-7f3a9c21:t0001:self';

const meetingNote = (more: Record<string, unknown> = {}) =>
  jsonLinesNote(
    {
      type: 'meeting',
      atlas_import: 'meeting/v1',
      atlas_import_outcome: 'imported',
      title: 'Standup',
      date: '2026-10-06',
      start: '09:30',
      provider: IDENTITY.provider,
      external_id: IDENTITY.externalId,
      attendees: [],
      ...more,
    },
    MEETING_BODY,
  );

const MEETING_TYPE_FILE = jsonLinesNote({
  name: 'meeting',
  properties: { tasks: { kind: 'relation', target: 'task', many: true } },
});

const vault = (files: Record<string, string> = {}): ProposalVault =>
  proposalVault({
    [MEETING]: meetingNote(),
    '.atlas/types/meeting.md': MEETING_TYPE_FILE,
    ...files,
  });

const item = (more: Partial<MeetingItemTask> = {}): MeetingItemTask => ({
  kind: 'task',
  title: 'Send Mara the payroll file',
  folder: null,
  properties: { status: 'inbox' },
  body: 'Mara asked for it by Friday.\n',
  source: '[[2026-10-06 Standup#^t0001]]',
  atlasItem: ITEM_KEY,
  ...more,
});

const make = (setup: ProposalVault, task = item(), meeting = MEETING) =>
  makeTaskFromMeeting({
    ports: setup.ports,
    meeting: { path: vaultPath(meeting), identity: IDENTITY },
    item: task,
    notePaths: setup.paths().map(vaultPath),
    today: TODAY,
  });

/** What a refused make left: nothing written, the meeting as it was. */
async function expectNothingWritten(setup: ProposalVault, made: Promise<unknown>, reason: RegExp) {
  const before = setup.fixture.files.get(MEETING)?.text;
  await expect(made).rejects.toThrow(reason);
  expect(setup.fixture.writes).toEqual([]);
  expect(setup.paths()).not.toContain(TASK);
  expect(setup.fixture.files.get(MEETING)?.text).toBe(before);
}

describe('makeTaskFromMeeting', () => {
  it('makes the task citing its block, linked to its meeting and keyed by its item, and joins the meeting’s tasks', async () => {
    const setup = vault();
    const made = await make(setup);

    expect(setup.propertiesOf(TASK)).toEqual({
      type: 'task',
      status: 'inbox',
      meeting: '[[2026-10-06 Standup]]',
      atlas_item: ITEM_KEY,
      source: '[[2026-10-06 Standup#^t0001]]',
    });
    expect(setup.fixture.files.get(TASK)?.text).toContain('Mara asked for it by Friday.\n');
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
    expect(made.task).toBe(TASK);
    expect(made.wrote).toMatchObject([
      { kind: 'created', path: TASK },
      { kind: 'edited', path: MEETING },
    ]);
  });

  it('makes a follow-up the same way: a task to chase someone', async () => {
    const setup = vault();
    await make(
      setup,
      item({ kind: 'follow-up', properties: { status: 'inbox', tags: ['follow-up'] } }),
    );

    expect(setup.propertiesOf(TASK)).toMatchObject({ type: 'task', tags: ['follow-up'] });
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
  });

  it('writes neither the item’s key nor the meeting relation when it is given no key, as Accept makes it', async () => {
    const setup = vault();
    await make(setup, item({ atlasItem: null }));

    expect(setup.propertiesOf(TASK)).toEqual({
      type: 'task',
      status: 'inbox',
      source: '[[2026-10-06 Standup#^t0001]]',
    });
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
  });

  it('keeps the meeting’s other tasks, adding this one after them', async () => {
    const setup = vault({ [MEETING]: meetingNote({ tasks: ['[[Book the room]]'] }) });
    await make(setup);

    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual([
      '[[Book the room]]',
      '[[Send Mara the payroll file]]',
    ]);
  });

  it('makes its own task under a numbered name when one of that name is there, linking that one', async () => {
    const setup = vault({ [TASK]: jsonLinesNote({ type: 'task', status: 'archive' }) });
    const made = await make(setup);

    expect(made.task).toBe('Tasks/2026/10/Send Mara the payroll file 2.md');
    expect(setup.propertiesOf(TASK)).toEqual({ type: 'task', status: 'archive' });
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file 2]]']);
  });
});

describe('makeTaskFromMeeting — a title a wiki link cannot hold', () => {
  it.each([
    ['Fix bug #123', 'Tasks/2026/10/Fix bug 123.md'],
    ['Re: [Q3] plan', 'Tasks/2026/10/Re Q3 plan.md'],
    ['Notes on [draft]', 'Tasks/2026/10/Notes on draft.md'],
    ['Pick A|B for ^t0001', 'Tasks/2026/10/Pick A B for t0001.md'],
  ])(
    'names the file of “%s” so the meeting’s link reaches it, keeping the title exact',
    async (title, file) => {
      const setup = vault();
      const made = await make(setup, item({ title }));

      expect(made.task).toBe(file);
      expect(setup.propertiesOf(file)).toMatchObject({ title });
      const [link] = setup.propertiesOf(MEETING)?.['tasks'] as string[];
      const [target] = linkTargets(link ?? '');
      expect(resolveWikiLinkTarget(target ?? '', setup.paths().map(createVaultPath))).toBe(file);
    },
  );

  it('gives a task whose file name says its title no `title` of its own', async () => {
    const setup = vault();
    await make(setup);

    expect(setup.propertiesOf(TASK)).not.toHaveProperty('title');
  });
});

describe('makeTaskFromMeeting — a meeting’s `tasks` holding more than links', () => {
  it.each([
    ['a map', { 'Book the room': '[[Book the room]]' }],
    ['a list holding a map', ['[[Call Ines]]', { link: '[[Book the room]]' }]],
    ['a nested list', [['[[Book the room]]', '[[Call Ines]]']]],
    ['a list holding a number', ['[[Call Ines]]', 7]],
  ])('refuses to join %s, writing nothing', async (_shape, tasks) => {
    const setup = vault({ [MEETING]: meetingNote({ tasks }) });

    await expectNothingWritten(setup, make(setup), /tasks holds something other than links/);
  });
});

describe('makeTaskFromMeeting — the meeting it is made from', () => {
  it('refuses a meeting the import has not let in yet, writing nothing', async () => {
    const setup = vault({ [MEETING]: meetingNote({ atlas_import_outcome: undefined }) });
    // The JSON-lines writer leaves out an undefined key: the meeting carries no stamp.
    expect(setup.propertiesOf(MEETING)).not.toHaveProperty('atlas_import_outcome');
    await expectNothingWritten(
      setup,
      make(setup),
      /“2026-10-06 Standup” has not been let in by the import yet/,
    );
  });

  it('refuses a meeting the import stamped a copy, writing nothing', async () => {
    const setup = vault({ [MEETING]: meetingNote({ atlas_import_outcome: 'duplicate' }) });
    await expectNothingWritten(setup, make(setup), /is not the meeting this task is for/);
  });

  it('refuses a note that holds another meeting, writing nothing', async () => {
    const setup = vault({ [MEETING]: meetingNote({ external_id: 'gemini-00000000' }) });
    await expectNothingWritten(setup, make(setup), /is not the meeting this task is for/);
  });

  it('refuses a meeting in the Archive, writing nothing', async () => {
    const archived = `Archive/${MEETING}`;
    const setup = proposalVault({
      [archived]: meetingNote(),
      '.atlas/types/meeting.md': MEETING_TYPE_FILE,
    });
    await expect(make(setup, item(), archived)).rejects.toThrow(
      /The meeting “2026-10-06 Standup” has been archived; no task is made from it/,
    );
    expect(setup.fixture.writes).toEqual([]);
  });

  it('refuses a sync’s conflict copy of the meeting, writing nothing', async () => {
    const copy = 'Projects/Ledger/2026-10-06 Standup (conflict from Laptop).md';
    const setup = vault({ [copy]: meetingNote() });
    await expect(make(setup, item(), copy)).rejects.toThrow(/is not the meeting this task is for/);
    expect(setup.fixture.writes).toEqual([]);
  });

  it('refuses a meeting that is gone, writing nothing', async () => {
    const setup = proposalVault({ '.atlas/types/meeting.md': MEETING_TYPE_FILE });
    await expect(make(setup)).rejects.toThrow(/“2026-10-06 Standup” is not there any more/);
    expect(setup.fixture.writes).toEqual([]);
  });

  it('refuses while the meeting has unsaved typing, writing nothing', async () => {
    const setup = vault();
    setup.dirty.add(MEETING);
    await expectNothingWritten(setup, make(setup), /unsaved typing/);
  });

  it('refuses when the Meeting type has no `tasks` relation to join, writing nothing', async () => {
    const setup = vault({
      '.atlas/types/meeting.md': jsonLinesNote({ name: 'meeting', properties: { title: 'text' } }),
    });
    await expectNothingWritten(setup, make(setup), /has no relation called tasks/);
  });

  it('makes no second link when the meeting already lists the task', async () => {
    const setup = vault({ [MEETING]: meetingNote({ tasks: ['[[Send Mara the payroll file]]'] }) });
    const made = await make(setup);

    expect(made.wrote).toMatchObject([{ kind: 'created', path: TASK }]);
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
  });
});

describe('makeTaskFromMeeting — the task rules (ADR-0029)', () => {
  it('makes a task Waiting with nobody to wait on, as the task rules now allow (#202)', async () => {
    const setup = vault();
    await make(setup, item({ properties: { status: 'waiting' } }));

    expect(setup.propertiesOf(TASK)).toMatchObject({ type: 'task', status: 'waiting' });
    expect(setup.propertiesOf(TASK)).not.toHaveProperty('waiting_on');
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
  });

  it('refuses a task waiting on a person who is not a note any more, writing nothing', async () => {
    const setup = vault();
    const waiting = item({ properties: { status: 'waiting', waiting_on: '[[Tobias Fenn]]' } });
    await expectNothingWritten(setup, make(setup, waiting), /not a note any more/);
  });

  it('makes a task waiting on a person the vault has', async () => {
    const setup = vault({ 'People/Tobias Fenn.md': jsonLinesNote({ type: 'person' }) });
    await make(setup, item({ properties: { status: 'waiting', waiting_on: '[[Tobias Fenn]]' } }));
    expect(setup.propertiesOf(TASK)).toMatchObject({
      status: 'waiting',
      waiting_on: '[[Tobias Fenn]]',
    });
  });

  it('dates a task made already finished, as ticking it done would', async () => {
    const setup = vault();
    await make(setup, item({ properties: { status: 'archive' } }));
    expect(setup.propertiesOf(TASK)).toMatchObject({ status: 'archive', completed: TODAY });
  });
});

describe('makeTaskFromMeeting — when a write fails', () => {
  it('takes the task back when the meeting changes between the read and the join', async () => {
    const setup = vault();
    const { fs } = setup.ports;
    const sneaky = {
      ...setup.ports,
      fs: {
        ...fs,
        createNote: async (args: Parameters<typeof fs.createNote>[0]) => {
          const made = await fs.createNote(args);
          const before = setup.fixture.files.get(MEETING);
          if (before !== undefined) {
            setup.fixture.files.set(MEETING, { ...before, modified: before.modified + 1000 });
          }
          return made;
        },
      },
    };
    await expect(
      makeTaskFromMeeting({
        ports: sneaky,
        meeting: { path: vaultPath(MEETING), identity: IDENTITY },
        item: item(),
        notePaths: setup.paths().map(vaultPath),
        today: TODAY,
      }),
    ).rejects.toThrow(/changed just now; nothing was written\. Nothing was kept\./);
    expect(setup.paths()).not.toContain(TASK);
    expect(setup.propertiesOf(MEETING)?.['tasks']).toBeUndefined();
  });
});

describe('undoMadeTask', () => {
  it('trashes the task and takes it out of the meeting’s tasks', async () => {
    const setup = vault();
    const before = setup.fixture.files.get(MEETING)?.text;
    const made = await make(setup);

    await undoMadeTask({ ports: setup.ports, made });

    expect(setup.paths()).not.toContain(TASK);
    expect(setup.fixture.files.get(MEETING)?.text).toBe(before);
  });

  it('takes back nothing when the task changed since: all of it or none', async () => {
    const setup = vault();
    const made = await make(setup);
    const task = setup.fixture.files.get(TASK)!;
    setup.fixture.files.set(TASK, {
      text: `${task.text}Done half.\n`,
      modified: task.modified + 9,
    });
    const meeting = setup.fixture.files.get(MEETING)?.text;

    await expect(undoMadeTask({ ports: setup.ports, made })).rejects.toThrow(/changed since/);

    expect(setup.fixture.files.get(TASK)?.text).toContain('Done half.');
    expect(setup.fixture.files.get(MEETING)?.text).toBe(meeting);
  });

  it('takes back nothing when the meeting changed since: all of it or none', async () => {
    const setup = vault();
    const made = await make(setup);
    const meeting = setup.fixture.files.get(MEETING)!;
    setup.fixture.files.set(MEETING, {
      text: `${meeting.text}A note.\n`,
      modified: meeting.modified + 9,
    });

    await expect(undoMadeTask({ ports: setup.ports, made })).rejects.toThrow(/changed since/);

    expect(setup.paths()).toContain(TASK);
    expect(setup.fixture.files.get(MEETING)?.text).toContain('A note.');
  });

  it('trashes the task before putting the meeting back, leaving the meeting as it is when the Trash refuses', async () => {
    const setup = vault();
    const made = await make(setup);
    const meeting = setup.fixture.files.get(MEETING)?.text;
    const ports = {
      ...setup.ports,
      fs: {
        ...setup.ports.fs,
        trashEntry: async () => {
          throw new Error('Trash is not available');
        },
      },
    };

    await expect(undoMadeTask({ ports, made })).rejects.toThrow(
      '“Send Mara the payroll file” could not be taken back (Trash is not available), so it and the notes linking it were left as they were.',
    );

    expect(setup.paths()).toContain(TASK);
    expect(setup.fixture.files.get(MEETING)?.text).toBe(meeting);
  });

  it('takes back nothing while either note has unsaved typing', async () => {
    const setup = vault();
    const made = await make(setup);
    setup.dirty.add(MEETING);

    await expect(undoMadeTask({ ports: setup.ports, made })).rejects.toThrow(/unsaved typing/);

    expect(setup.paths()).toContain(TASK);
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
  });
});
