import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  parseObjectType,
  readSummaryBlock,
  renderSummaryBlock,
  splitFrontmatter,
  type MeetingSummary,
} from '@dfai/domain';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { MEETING_BODY, MEETING_HEADER } from '../testing/meeting-files.ts';
import {
  MeetingSummaryRefused,
  undoMeetingSummary,
  writeMeetingSummary,
  type MeetingSummaryWrite,
} from './write-meeting-summary.ts';

/**
 * #185: the one write to a meeting — its summary block, the block's keys and
 * its `tasks` — refused whole when the meeting has unsaved typing, changed
 * since it was read, or is gone, and never over the person's edits.
 */

const TODAY = '2026-10-11';
const MEETING = createVaultPath('Meetings/2026-10-06 Standup.md');
const TASK = createVaultPath('Tasks/Send the file.md');
const SUMMARY: MeetingSummary = {
  model: 'claude-sonnet-5-5',
  date: TODAY,
  summary: 'Go-live moves a week.',
  keyPoints: [],
  decisions: [],
  actionItems: [{ title: 'Send the file', assignee: 'you', turn: 't0001', taskMade: true }],
  openQuestions: [],
};
const BLOCK = renderSummaryBlock(SUMMARY).text;

const meetingType = (tasks: unknown) =>
  jsonNote({ name: 'meeting', properties: tasks === null ? {} : { tasks } }, '');

function setUp({ tasks = { kind: 'relation', target: 'task', many: true } as unknown } = {}) {
  const vault = automationVault({
    notes: {
      [MEETING]: jsonNote({ ...MEETING_HEADER, atlas_import_outcome: 'imported' }, MEETING_BODY),
      [TASK]: jsonNote({ type: 'task', status: 'inbox' }, ''),
      '.atlas/types/meeting.md': meetingType(tasks),
    },
    today: TODAY,
    types: [parseObjectType({ name: 'meeting', label: 'Meeting', properties: {} })],
  });
  const read = async () => (await vault.ports.fs.readTextFile(MEETING)).modified;
  const write = async (more: Partial<MeetingSummaryWrite> = {}) =>
    writeMeetingSummary(vault.ports, {
      meeting: MEETING,
      modified: more.modified ?? (await read()),
      block: BLOCK,
      summaryOf: 'abcd1234',
      model: 'claude-sonnet-5-5',
      tasks: [TASK],
      notePaths: [MEETING, TASK],
      ...more,
    });
  const body = () => splitFrontmatter(vault.files.get(MEETING) ?? '').body;
  return { vault, write, read, body, properties: () => vault.properties(MEETING) };
}

describe('writeMeetingSummary', () => {
  it('writes the block, its keys and the tasks in one write', async () => {
    const at = setUp();
    const written = await at.write();
    expect(written).toEqual({
      digest: readSummaryBlock(at.body()).kind === 'block' ? expect.any(String) : null,
      replaced: null,
      kept: null,
      joined: [TASK],
      filed: null,
      projectLeft: null,
    });
    expect(at.properties()).toMatchObject({
      atlas_summary_digest: written.digest,
      atlas_summary_of: 'abcd1234',
      atlas_summary_model: 'claude-sonnet-5-5',
      tasks: ['[[Send the file]]'],
    });
    expect(at.vault.log.filter((line) => line === `write ${MEETING}`)).toHaveLength(1);
  });

  it('writes the tasks alone when there is no block to write', async () => {
    const at = setUp();
    const written = await at.write({ block: null });
    expect(written).toEqual({
      digest: null,
      replaced: null,
      kept: null,
      joined: [TASK],
      filed: null,
      projectLeft: null,
    });
    expect(at.properties()).not.toHaveProperty('atlas_summary_digest');
    expect(at.properties()['tasks']).toEqual(['[[Send the file]]']);
  });

  it('writes nothing when there is neither a block nor a task to join', async () => {
    const at = setUp();
    await at.write({ block: null, tasks: [] });
    expect(at.vault.log).toEqual([]);
  });

  it('keeps a block the person edited and still joins the tasks', async () => {
    const at = setUp();
    await at.write({ tasks: [] });
    const edited = (at.vault.files.get(MEETING) ?? '').replace(
      'Go-live moves a week.',
      'Go-live moves.',
    );
    await at.vault.ports.fs.writeTextFile({
      path: MEETING,
      contents: edited,
      expectedModified: null,
    });

    const written = await at.write({
      block: renderSummaryBlock({ ...SUMMARY, summary: 'New.' }).text,
    });

    expect(written.digest).toBeNull();
    expect(written.kept?.refusal).toBe('edited');
    expect(at.body()).toContain('> Go-live moves.');
    expect(at.properties()['tasks']).toEqual(['[[Send the file]]']);
  });

  it('joins no task through a Meeting type with no tasks relation, and still writes the block', async () => {
    const at = setUp({ tasks: null });
    const written = await at.write();
    expect(written.joined).toEqual([]);
    expect(at.properties()).not.toHaveProperty('tasks');
    expect(written.digest).not.toBeNull();
  });

  it('is refused, writing nothing, with unsaved typing, a change since it was read, or no meeting', async () => {
    const typing = setUp();
    typing.vault.unsaved.add(MEETING);
    await expect(typing.write()).rejects.toThrow(MeetingSummaryRefused);
    await expect(typing.write()).rejects.toThrow(/has unsaved typing/);

    const changed = setUp();
    const modified = await changed.read();
    await expect(changed.write({ modified: modified - 1 })).rejects.toThrow(
      /changed while Claude read it/,
    );

    const gone = setUp();
    gone.vault.files.delete(MEETING);
    await expect(gone.write({ modified: 0 })).rejects.toThrow(/is not there any more/);
    expect(typing.vault.log.concat(changed.vault.log)).toEqual([]);
  });
});

describe('a meeting written between the read and the write', () => {
  /** The meeting changes on disk right after it is first read: the write's own check is the last guard. */
  const racing = (at: ReturnType<typeof setUp>) => {
    const { fs } = at.vault.ports;
    const read = fs.readTextFile.bind(fs);
    let reads = 0;
    Object.assign(fs, {
      readTextFile: async (path: string) => {
        const file = await read(path as Parameters<typeof read>[0]);
        reads += path === MEETING ? 1 : 0;
        if (path === MEETING && reads === 1) {
          await fs.writeTextFile({
            path: MEETING,
            contents: `${file.text}\nTyped.\n`,
            expectedModified: null,
          });
        }
        return file;
      },
    });
  };

  it('is refused when writing the summary, with nothing of it written', async () => {
    const at = setUp();
    const modified = await at.read();
    racing(at);
    await expect(at.write({ modified })).rejects.toThrow(/changed while Claude read it/);
    expect(readSummaryBlock(at.body())).toEqual({ kind: 'none' });
  });

  it('is refused when undoing it, leaving the summary', async () => {
    const at = setUp();
    const { digest } = await at.write();
    racing(at);
    await expect(
      undoMeetingSummary(at.vault.ports, {
        meeting: MEETING,
        summary: { digest: digest! },
        trashing: [],
        trash: async () => [],
        notePaths: [],
      }),
    ).rejects.toThrow(/changed just now, so its summary was left as it is/);
    expect(readSummaryBlock(at.body()).kind).toBe('block');
  });

  it('raises a fault reading the meeting as it is, not as a refusal', async () => {
    const at = setUp();
    Object.assign(at.vault.ports.fs, {
      readTextFile: async () => {
        throw new Error('the disk is gone');
      },
    });
    await expect(at.write({ modified: 0 })).rejects.toThrow('the disk is gone');
  });
});

describe('undoMeetingSummary', () => {
  it('takes the block, its keys and the trashed tasks’ links out', async () => {
    const at = setUp();
    const before = at.body();
    const { digest } = await at.write();
    await undoMeetingSummary(at.vault.ports, {
      meeting: MEETING,
      summary: { digest: digest! },
      trashing: [TASK],
      trash: async (tasks) => tasks,
      notePaths: [MEETING, TASK],
    });
    expect(at.body()).toBe(before);
    expect(at.properties()).not.toHaveProperty('atlas_summary_digest');
    expect(at.properties()).not.toHaveProperty('tasks');
  });

  it('keeps the link to a task the Trash did not take, in the same one write (#685)', async () => {
    const at = setUp();
    const { digest } = await at.write();
    const linked = at.properties()['tasks'];
    const writes = at.vault.log.filter((line) => line === `write ${MEETING}`).length;
    await undoMeetingSummary(at.vault.ports, {
      meeting: MEETING,
      summary: { digest: digest! },
      trashing: [TASK],
      trash: async () => [],
      notePaths: [MEETING, TASK],
    });
    expect(at.properties()).not.toHaveProperty('atlas_summary_digest');
    expect(at.properties()['tasks']).toEqual(linked);
    expect(at.vault.log.filter((line) => line === `write ${MEETING}`)).toHaveLength(writes + 1);
  });

  it('takes out the links of only the tasks the Trash took (#685)', async () => {
    const at = setUp();
    const other = createVaultPath('Tasks/Book the room.md');
    const notePaths = [MEETING, TASK, other];
    const { digest } = await at.write({ tasks: [TASK, other], notePaths });
    expect(at.properties()['tasks']).toEqual(['[[Send the file]]', '[[Book the room]]']);
    await undoMeetingSummary(at.vault.ports, {
      meeting: MEETING,
      summary: { digest: digest! },
      trashing: [TASK, other],
      trash: async () => [other],
      notePaths,
    });
    expect(at.properties()['tasks']).toEqual(['[[Send the file]]']);
  });

  it('asks the Trash for nothing when the meeting refuses', async () => {
    const at = setUp();
    const { digest } = await at.write();
    at.vault.unsaved.add(MEETING);
    let asked = false;
    await expect(
      undoMeetingSummary(at.vault.ports, {
        meeting: MEETING,
        summary: { digest: digest! },
        trashing: [TASK],
        trash: async (tasks) => {
          asked = true;
          return tasks;
        },
        notePaths: [MEETING, TASK],
      }),
    ).rejects.toThrow(/has unsaved typing/);
    expect(asked).toBe(false);
  });

  it('is refused when the block was edited, or typed in', async () => {
    const at = setUp();
    const { digest } = await at.write();
    const edited = (at.vault.files.get(MEETING) ?? '').replace('Go-live moves a week.', 'Mine.');
    await at.vault.ports.fs.writeTextFile({
      path: MEETING,
      contents: edited,
      expectedModified: null,
    });
    const undo = () =>
      undoMeetingSummary(at.vault.ports, {
        meeting: MEETING,
        summary: { digest: digest! },
        trashing: [],
        trash: async () => [],
        notePaths: [],
      });
    await expect(undo()).rejects.toThrow(/edited since Claude wrote it/);
    at.vault.unsaved.add(MEETING);
    await expect(undo()).rejects.toThrow(/has unsaved typing, so its summary was left as it is/);
  });
});
