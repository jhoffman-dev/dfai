import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  filedUnderStamp,
  filingRefusal,
  inboxItem,
  isInInbox,
  inboxWaiting,
  isProcessMove,
  processDestination,
  processRefusal,
} from './inbox.ts';

const path = (raw: string): VaultPath => createVaultPath(raw);

describe('isInInbox', () => {
  it('is any note under the Inbox folder at the root, however it is cased', () => {
    expect(isInInbox('Inbox/Call the bank.md')).toBe(true);
    expect(isInInbox('inbox/Meetings/2026-10-01 Standup.md')).toBe(true);
  });

  it('is not a note elsewhere, nor one whose folder merely starts with the word', () => {
    expect(isInInbox('Projects/Inbox/Plan.md')).toBe(false);
    expect(isInInbox('Inboxes/Plan.md')).toBe(false);
    expect(isInInbox('Inbox.md')).toBe(false);
  });
});

describe('processRefusal', () => {
  const refusal = (raw: string, type: string | null = null) =>
    processRefusal({ path: path(raw), type });

  it('lets a note in the Inbox be processed, one dropped into Inbox/Proposals included', () => {
    expect(refusal('Inbox/Call the bank.md', 'task')).toBeNull();
    expect(refusal('Inbox/Proposals/Ideas.md')).toBeNull();
  });

  it('refuses a note that is not in the Inbox, or is not a note', () => {
    expect(refusal('Projects/Plan.md')).toBe('It is not in the Inbox.');
    expect(refusal('Inbox/scan.pdf')).toBe('Only notes can be processed.');
  });

  it('refuses a proposal by its type, wherever in the Inbox it sits', () => {
    expect(refusal('Inbox/Proposals/Send the file.md', 'proposal')).toBe(
      'A proposal is answered, not filed: accept or reject it.',
    );
    expect(refusal('Inbox/Send the file.md', ' Proposal ')).not.toBeNull();
  });
});

describe('filingRefusal on a Project, by the PARA value it holds (#213)', () => {
  const archived = 'That is archived: unarchive it to file notes under it.';
  it('files under a project or an area, and under a PARA DFAI cannot read, as a project', () => {
    for (const para of [undefined, 'project', 'Area', 'Life admin']) {
      expect(filingRefusal({ path: path('Projects/DFAI.md'), type: 'project', para })).toBeNull();
    }
  });

  it('refuses one archived by its value, as one moved to the Archive', () => {
    expect(
      filingRefusal({ path: path('Projects/DFAI.md'), type: 'Project', para: ' archive ' }),
    ).toBe(archived);
    expect(filingRefusal({ path: path('Archive/Projects/DFAI.md'), type: 'project' })).toBe(
      archived,
    );
  });

  it('refuses a resource with the words a note of the Resource type had', () => {
    const before = filingRefusal({ path: path('Manual.md'), type: 'resource' });
    expect(before).toBe('Project links to a project or area, not a resource');
    expect(filingRefusal({ path: path('Manual.md'), type: 'project', para: 'Resource' })).toBe(
      before,
    );
  });
});

describe('filingRefusal', () => {
  it('files under a project or an area', () => {
    expect(filingRefusal({ path: path('Projects/DFAI.md'), type: 'project' })).toBeNull();
    expect(filingRefusal({ path: path('Areas/Garden.md'), type: 'area' })).toBeNull();
  });

  it('refuses a note of another type', () => {
    expect(filingRefusal({ path: path('People/Mara Quill.md'), type: 'person' })).toBe(
      'Project links to a project or area, not a person',
    );
  });

  it('refuses a note with no type', () => {
    expect(filingRefusal({ path: path('Plan.md'), type: null })).toContain('neither');
  });

  it('refuses a project still in the Inbox, an archived one, or one of DFAI’s own files', () => {
    expect(filingRefusal({ path: path('Inbox/New project.md'), type: 'project' })).toContain(
      'still in the Inbox',
    );
    expect(filingRefusal({ path: path('Archive/Projects/Old.md'), type: 'project' })).toContain(
      'archived',
    );
    expect(filingRefusal({ path: path('.atlas/templates/Project.md'), type: 'project' })).toContain(
      'DFAI’s own files',
    );
  });
});

// #214: filing only links, so a project's own folder no longer matters.
describe('filing under a project wherever its note is kept', () => {
  it.each([['Inbox.md'], ['Archive.md'], ['node_modules.md'], ['Projects/Inbox.md']])(
    'files under a project at %s: nothing lands in its folder',
    (at) => {
      expect(filingRefusal({ path: path(at), type: 'project' })).toBeNull();
    },
  );

  it('files under a project kept deeper than the vault is read for a note filed beside it', () => {
    const folders = Array.from({ length: 32 }, (_, at) => `f${at}`).join('/');
    expect(filingRefusal({ path: path(`${folders}/Deep.md`), type: 'project' })).toBeNull();
  });
});

describe('processDestination', () => {
  it('files a note out of the Inbox into its home folder by its own name, leaving the Inbox folders behind', () => {
    expect(
      processDestination({
        path: path('Inbox/Meetings/2026-10-01 Standup.md'),
        folder: path('Meetings/2026/10'),
        taken: new Set(),
      }),
    ).toBe('Meetings/2026/10/2026-10-01 Standup.md');
  });

  it('numbers it when its home folder already has a note of that name', () => {
    expect(
      processDestination({
        path: path('Inbox/Notes.md'),
        folder: path('Notes/2026'),
        taken: new Set(['notes/2026/notes.md']),
      }),
    ).toBe('Notes/2026/Notes 2.md');
  });
});

describe('filedUnderStamp', () => {
  it('links the project by its name', () => {
    const notePaths = [path('Projects/DFAI.md'), path('Inbox/Call.md')];
    expect(filedUnderStamp({ project: path('Projects/DFAI.md'), notePaths })).toEqual({
      project: '[[DFAI]]',
    });
  });

  it('links it by its path where the name alone would open another note', () => {
    const notePaths = [path('Areas/Garden.md'), path('Projects/Garden.md')];
    expect(filedUnderStamp({ project: path('Projects/Garden.md'), notePaths })).toEqual({
      project: '[[Projects/Garden]]',
    });
  });
});

describe('inboxItem', () => {
  it('says which folder of the Inbox a note arrived in, and its type', () => {
    expect(
      inboxItem({ path: path('Inbox/Meetings/Standup.md'), title: 'Standup', type: 'meeting' }),
    ).toEqual({
      path: 'Inbox/Meetings/Standup.md',
      title: 'Standup',
      type: 'meeting',
      arrivedIn: 'Meetings',
      importOutcome: 'pending',
      importError: null,
      task: null,
      written: {
        project: null,
        projectNames: [],
        due: null,
        dueWritten: '',
        waitingOn: null,
        waitingOnNames: '',
      },
    });
  });

  it('carries what any note has written under project, due and waiting_on, resolved or not (#903)', () => {
    const item = inboxItem({
      path: path('Inbox/Payroll article.md'),
      title: 'Payroll article',
      type: 'reference',
      project: null,
      projectWritten: '[[Old Payroll]]',
      due: null,
      dueWritten: 'next Friday',
      waitingOn: 'People/Mara Quill.md',
      waitingOnNames: '[[Mara Quill]]',
    });
    expect(item.task).toBeNull();
    expect(item.written).toEqual({
      project: null,
      projectNames: ['Old Payroll'],
      due: null,
      dueWritten: 'next Friday',
      waitingOn: 'People/Mara Quill.md',
      waitingOnNames: 'Mara Quill',
    });
  });

  it('reads a plain note at the top of the Inbox as having no type and no folder', () => {
    expect(inboxItem({ path: path('Inbox/Call.md'), title: 'Call', type: null })).toMatchObject({
      type: null,
      arrivedIn: '',
    });
    expect(inboxItem({ path: path('Inbox/Call.md'), title: 'Call', type: '  ' }).type).toBeNull();
  });
});

describe('inboxItem — a task (#112)', () => {
  it('carries what the task says, for its row to be clarified from', () => {
    const item = inboxItem({
      path: path('Tasks/Chase the invoice.md'),
      title: 'Chase the invoice',
      type: 'Task',
      status: 'inbox',
      project: 'Projects/DFAI.md',
      waitingOn: 'People/Mara Quill.md',
      waitingOnNames: '[[People/Mara Quill|Mara Quill]]',
      defer: '2026-10-20',
      due: null,
      priority: '1',
    });
    expect(item.task).toEqual({
      status: 'inbox',
      project: 'Projects/DFAI.md',
      waitingOn: 'People/Mara Quill.md',
      waitingOnNames: 'Mara Quill',
      defer: '2026-10-20',
      due: null,
      priority: 1,
      priorityWritten: '1',
    });
    // It lives outside the Inbox folder, so it arrived in none of its folders.
    expect(item.arrivedIn).toBe('');
  });

  it('reads a priority that is not one of the four, or missing, as none (#913)', () => {
    const held = (priority: unknown) =>
      inboxItem({ path: path('Inbox/Call.md'), title: 'Call', type: 'task', priority }).task
        ?.priority;
    expect(held('3')).toBe(3);
    for (const none of [undefined, null, '', '0', '5', 'high']) expect(held(none)).toBeNull();
  });

  it('reads a status that is not one of the eight, or missing, as none', () => {
    const held = (status: unknown) =>
      inboxItem({ path: path('Inbox/Call.md'), title: 'Call', type: 'task', status }).task?.status;
    expect(held('doing')).toBeNull();
    expect(held(null)).toBeNull();
    expect(held('next-action')).toBe('next-action');
  });

  it('has nothing of a task for a note that is not one', () => {
    const meeting = { path: path('Inbox/Meetings/Standup.md'), title: 'Standup', type: 'meeting' };
    expect(inboxItem({ ...meeting, status: 'inbox' }).task).toBeNull();
    expect(inboxItem({ path: path('Inbox/Idea.md'), title: 'Idea', type: null }).task).toBeNull();
  });
});

describe('isProcessMove', () => {
  it('is a note filed out of the Inbox under its own name, numbered or not', () => {
    const from = path('Inbox/Meetings/Kickoff.md');
    expect(isProcessMove(from, path('Projects/DFAI/Kickoff.md'))).toBe(true);
    expect(isProcessMove(from, path('projects/atlas/kickoff.md'))).toBe(true);
    expect(isProcessMove(from, path('Projects/DFAI/Kickoff 2.md'))).toBe(true);
  });

  it('is not a move within the Inbox, into the Archive, or to another name', () => {
    const from = path('Inbox/Kickoff.md');
    expect(isProcessMove(from, path('Inbox/Meetings/Kickoff.md'))).toBe(false);
    expect(isProcessMove(from, path('Archive/Inbox/Kickoff.md'))).toBe(false);
    expect(isProcessMove(from, path('Projects/DFAI/Launch.md'))).toBe(false);
    expect(isProcessMove(path('Notes/Kickoff.md'), path('Projects/DFAI/Kickoff.md'))).toBe(false);
  });
});

describe('inboxWaiting', () => {
  it('counts notes to file and proposals to answer, a side not read yet as none', () => {
    expect(inboxWaiting({ toFile: 2, toAnswer: 1 })).toBe(3);
    expect(inboxWaiting({ toFile: null, toAnswer: 1 })).toBe(1);
    expect(inboxWaiting({ toFile: 2, toAnswer: null })).toBe(2);
    expect(inboxWaiting({ toFile: null, toAnswer: null })).toBeNull();
  });
});
