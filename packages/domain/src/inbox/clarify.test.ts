import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { clarifyVocabulary, TASK_TYPE_FILE } from '../gtd/task-type.ts';
import { parseObjectType } from '../types/property-def.ts';
import { clarifyPlan, waitingOnRefusal, type Clarification } from './clarify.ts';

/** #112: what clarifying an Inbox row writes, judged whole before anything is. */

const path = (raw: string): VaultPath => createVaultPath(raw);
const TODAY = '2026-10-11';
const NOTES = [
  'Inbox/Call the bank.md',
  'Tasks/Imported.md',
  'Projects/DFAI.md',
  'People/Mara Quill.md',
].map(path);
const TASK = { type: 'task', status: 'inbox' };

const plan = (
  clarification: Clarification,
  { at = 'Inbox/Call the bank.md', properties = TASK as Record<string, unknown> } = {},
) => clarifyPlan({ path: path(at), properties, clarification, notePaths: NOTES, today: TODAY });

describe('clarifyPlan — a task', () => {
  it('writes a status alone, and files nothing: a single action needs no project', () => {
    expect(plan({ status: 'next-action' })).toEqual({
      changes: { status: 'next-action' },
      fileUnder: null,
    });
  });

  it('writes Waiting and who it waits on as one change, the person linked by name', () => {
    expect(plan({ status: 'waiting', waitingOn: path('People/Mara Quill.md') })).toEqual({
      changes: { status: 'waiting', waiting_on: '[[Mara Quill]]' },
      fileUnder: null,
    });
  });

  it('writes Waiting with nobody to wait on: who is offered, never demanded (#202)', () => {
    expect(plan({ status: 'waiting' })).toEqual({
      changes: { status: 'waiting' },
      fileUnder: null,
    });
  });

  it('lets a task that already says who it waits on be moved to Waiting', () => {
    const waiting = plan(
      { status: 'waiting' },
      { properties: { ...TASK, waiting_on: '[[Mara Quill]]' } },
    );
    expect(waiting).toEqual({ changes: { status: 'waiting' }, fileUnder: null });
  });

  it('takes the person away from a task that stays Waiting', () => {
    const waiting = { type: 'task', status: 'waiting', waiting_on: '[[Mara Quill]]' };
    expect(plan({ waitingOn: null }, { properties: waiting })).toEqual({
      changes: { waiting_on: null },
      fileUnder: null,
    });
  });

  it('dates a task clarified straight to Archive, as ticking it would', () => {
    expect(plan({ status: 'archive' })).toEqual({
      changes: { status: 'archive', completed: TODAY },
      fileUnder: null,
    });
  });

  it('writes defer, due and contexts; a null or an empty list takes one away', () => {
    expect(
      plan({ defer: '2026-10-20', due: null, contexts: [' @desk ', '', '@desk', '@phone'] }),
    ).toEqual({
      changes: { defer: '2026-10-20', due: null, contexts: ['@desk', '@phone'] },
      fileUnder: null,
    });
    expect(plan({ contexts: [] })).toEqual({ changes: { contexts: null }, fileUnder: null });
  });

  it('refuses a status that is not one of the eight, and a day that is not a day', () => {
    expect(plan({ status: 'done' })).toEqual({
      refused: expect.stringMatching(/“done” is not a status a task can have: Inbox, Backlog,/),
    });
    expect(plan({ due: '2026-02-30' })).toEqual({
      refused: '“2026-02-30” is not a day (YYYY-MM-DD).',
    });
    expect(plan({ defer: 'tomorrow' })).toEqual({
      refused: '“tomorrow” is not a day (YYYY-MM-DD).',
    });
  });

  it('files a task in the Inbox folder under its project, leaving the link to the filing', () => {
    expect(plan({ status: 'next-action', project: path('Projects/DFAI.md') })).toEqual({
      changes: { status: 'next-action' },
      fileUnder: 'Projects/DFAI.md',
    });
    expect(plan({ project: path('Projects/DFAI.md') })).toEqual({
      changes: {},
      fileUnder: 'Projects/DFAI.md',
    });
  });

  it('links a task that lives elsewhere to its project, and leaves it where it is', () => {
    expect(plan({ project: path('Projects/DFAI.md') }, { at: 'Tasks/Imported.md' })).toEqual({
      changes: { project: '[[DFAI]]' },
      fileUnder: null,
    });
  });

  it('refuses a clarification that chooses nothing', () => {
    expect(plan({})).toEqual({ refused: expect.stringMatching(/^Nothing was chosen/) });
  });
});

describe('clarifyPlan — a note that is not a task', () => {
  const MEETING = { type: 'meeting' };

  it('files it, writing nothing of its own', () => {
    expect(plan({ project: path('Projects/DFAI.md') }, { properties: MEETING })).toEqual({
      changes: {},
      fileUnder: 'Projects/DFAI.md',
    });
  });

  it('refuses a status, a wait or a date', () => {
    for (const clarification of [
      { status: 'next-action' },
      { waitingOn: path('People/Mara Quill.md') },
      { due: '2026-10-20' },
    ]) {
      expect(plan(clarification, { properties: MEETING })).toEqual({
        refused: expect.stringMatching(/^Only a task is given a status/),
      });
    }
  });

  it('refuses a proposal, which is answered', () => {
    expect(
      plan({ project: path('Projects/DFAI.md') }, { properties: { type: 'Proposal' } }),
    ).toEqual({
      refused: 'A proposal is answered, not clarified: accept or reject it.',
    });
  });

  it('refuses linking one outside the Inbox folder: only a task waits there', () => {
    expect(
      plan({ project: path('Projects/DFAI.md') }, { at: 'Tasks/Imported.md', properties: {} }),
    ).toEqual({ refused: 'It is not in the Inbox.' });
  });

  it('makes a plain note a task, in the Inbox unless a status is given with it', () => {
    expect(plan({ asTask: true }, { properties: {} })).toEqual({
      changes: { type: 'task', status: 'inbox' },
      fileUnder: null,
    });
    expect(plan({ asTask: true, status: 'someday' }, { properties: {} })).toEqual({
      changes: { type: 'task', status: 'someday' },
      fileUnder: null,
    });
  });

  it('makes a note a Waiting task in one change, with nobody to wait on', () => {
    expect(plan({ asTask: true, status: 'waiting' }, { properties: {} })).toEqual({
      changes: { type: 'task', status: 'waiting' },
      fileUnder: null,
    });
  });

  it('holds a note made a task to the task rules in the same change', () => {
    expect(plan({ asTask: true, status: 'archive' }, { properties: {} })).toEqual({
      changes: { type: 'task', status: 'archive', completed: TODAY },
      fileUnder: null,
    });
  });

  it('does not make a note of another type a task, and leaves a task one', () => {
    expect(plan({ asTask: true }, { properties: MEETING })).toEqual({
      refused: 'It is a meeting: only a plain note is made a task.',
    });
    expect(plan({ asTask: true, due: '2026-10-20' })).toEqual({
      changes: { due: '2026-10-20' },
      fileUnder: null,
    });
  });
});

describe('waitingOnRefusal', () => {
  it('lets a task wait on a person, however the type is cased', () => {
    expect(waitingOnRefusal({ path: path('People/Mara Quill.md'), type: 'person' })).toBeNull();
    expect(waitingOnRefusal({ path: path('People/Mara Quill.md'), type: ' Person ' })).toBeNull();
  });

  it('refuses a note of another type, or of none', () => {
    expect(waitingOnRefusal({ path: path('Projects/DFAI.md'), type: 'project' })).toBe(
      'Waiting on links to a person, not a project',
    );
    expect(waitingOnRefusal({ path: path('Notes/Idea.md'), type: null })).toBe(
      'A task waits on a person, and that note is not one.',
    );
  });

  it('refuses an archived person, and one of DFAI’s own files', () => {
    expect(
      waitingOnRefusal({ path: path('Archive/People/Tobias Fenn.md'), type: 'person' }),
    ).toMatch(/archived/);
    expect(waitingOnRefusal({ path: path('.atlas/types/person.md'), type: 'person' })).toMatch(
      /DFAI’s own files/,
    );
  });
});

/** Review round on #112. */
describe('clarifyPlan — who a task waits on, and a change of mind', () => {
  const MARA = path('People/Mara Quill.md');

  it('does not write a person on a task that is not, and is not being made, Waiting', () => {
    expect(plan({ status: 'next-action', waitingOn: MARA })).toEqual({
      changes: { status: 'next-action' },
      fileUnder: null,
    });
    expect(plan({ waitingOn: MARA })).toEqual({
      refused: expect.stringMatching(/^Nothing was chosen/),
    });
  });

  it('writes a person on a task that is already Waiting', () => {
    const waiting = { type: 'task', status: 'waiting', waiting_on: '[[Tobias Fenn]]' };
    expect(plan({ waitingOn: MARA }, { properties: waiting })).toEqual({
      changes: { waiting_on: '[[Mara Quill]]' },
      fileUnder: null,
    });
  });

  it('keeps who a task waited on when it leaves Waiting, as every other write of a task does', () => {
    const waiting = { type: 'task', status: 'waiting', waiting_on: '[[Mara Quill]]' };
    expect(plan({ status: 'next-action' }, { properties: waiting })).toEqual({
      changes: { status: 'next-action' },
      fileUnder: null,
    });
  });
});

describe('clarifyPlan and a task’s priority (#913)', () => {
  const plan = (clarification: Clarification) =>
    clarifyPlan({
      path: path('Inbox/Call the bank.md'),
      properties: TASK,
      clarification,
      notePaths: NOTES,
      today: TODAY,
    });

  it('writes the priority picked in the same save, and takes it away', () => {
    expect(plan({ priority: 2 })).toMatchObject({ changes: { priority: 2 } });
    expect(plan({ priority: null })).toMatchObject({ changes: { priority: null } });
  });

  it('refuses nothing for its priority: a soft field is written as given', () => {
    expect(plan({ priority: 7 })).toMatchObject({ changes: { priority: 7 } });
  });
});

describe('clarifyPlan — what the vault’s Task type lets a task be', () => {
  const OWN = parseObjectType({
    name: 'task',
    properties: { status: { kind: 'select', options: ['todo', 'backlog', 'done'], done: 'done' } },
  });
  const inOwnVault = (clarification: Clarification, properties: Record<string, unknown> = TASK) =>
    clarifyPlan({
      path: path('Inbox/Call the bank.md'),
      properties,
      clarification,
      notePaths: NOTES,
      today: TODAY,
      vocabulary: clarifyVocabulary([OWN]),
    });

  it('offers only the GTD statuses that type declares, and all eight with GTD’s own or none', () => {
    expect(clarifyVocabulary([OWN])).toEqual({
      statuses: ['backlog'],
      startsAt: null,
    });
    expect(clarifyVocabulary([TASK_TYPE_FILE.type]).statuses).toHaveLength(8);
    expect(clarifyVocabulary([])).toMatchObject({ startsAt: 'inbox' });
    expect(clarifyVocabulary([]).statuses).toHaveLength(8);
  });

  it('refuses a status that type does not declare, and writes one it does', () => {
    expect(inOwnVault({ status: 'next-action' })).toEqual({
      refused: expect.stringMatching(/Task type has no “Next Action” status/),
    });
    expect(inOwnVault({ status: 'backlog' })).toEqual({
      changes: { status: 'backlog' },
      fileUnder: null,
    });
  });

  it('makes a note a task without a status there, rather than one the type does not have', () => {
    expect(inOwnVault({ asTask: true }, {})).toEqual({
      changes: { type: 'task' },
      fileUnder: null,
    });
  });

  it('says back only the start of a status nobody knows', () => {
    const answer = plan({ status: 'x'.repeat(5000) });
    expect('refused' in answer && answer.refused.length).toBeLessThan(200);
  });
});

describe('clarifyPlan — notes it leaves alone', () => {
  it('refuses an archived task', () => {
    expect(plan({ status: 'next-action' }, { at: 'Archive/Tasks/Old.md' })).toEqual({
      refused: 'It is archived: unarchive it to decide on it.',
    });
  });

  it('never makes a task of a note whose type is written as a list or a number', () => {
    for (const type of [['meeting'], 5]) {
      expect(plan({ asTask: true }, { properties: { type } })).toEqual({
        refused: 'It already says what type it is: only a plain note is made a task.',
      });
    }
  });
});
