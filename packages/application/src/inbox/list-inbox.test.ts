import { describe, expect, it } from 'vitest';
import { fakeIndexPort, fakeMarkdown } from '../testing/fake-ports.ts';
import { assistHeld } from '@dfai/domain';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { listInbox } from './list-inbox.ts';

describe('listInbox', () => {
  it('lists every note waiting in the Inbox, of any type or none', async () => {
    const query = atlasQueryIndex({
      markdown: fakeMarkdown(),
      files: {
        'Inbox/Call the bank.md': '---\ntype: task\n---\n',
        'Inbox/Meetings/Standup.md': '---\ntype: meeting\n---\n',
        'Inbox/Idea.md': 'A thought.\n',
        'Projects/DFAI.md': '---\ntype: project\n---\n',
      },
    });
    const { items, truncated } = await listInbox({ index: fakeIndexPort({ query }) });
    expect(truncated).toBe(false);
    expect(items.map((item) => [item.path, item.type, item.arrivedIn])).toEqual(
      expect.arrayContaining([
        ['Inbox/Call the bank.md', 'task', ''],
        ['Inbox/Meetings/Standup.md', 'meeting', 'Meetings'],
        ['Inbox/Idea.md', null, ''],
      ]),
    );
    expect(items).toHaveLength(3);
  });

  it('leaves out proposals by their type, wherever they are, and lists any other note', async () => {
    const query = atlasQueryIndex({
      markdown: fakeMarkdown(),
      files: {
        'Inbox/Call the bank.md': '---\ntype: task\n---\n',
        'Inbox/Proposals/Send the file.md': '---\ntype: proposal\nkind: task\n---\n',
        'inbox/proposals/Lower case.md': '---\ntype: Proposal\nkind: task\n---\n',
        'Inbox/Moved by hand.md': '---\ntype: proposal\nkind: task\n---\n',
        'Inbox/Proposals/Ideas.md': 'A plain note dropped in with the proposals.\n',
      },
    });
    const { items } = await listInbox({ index: fakeIndexPort({ query }) });
    expect(items.map((item) => item.path).sort()).toEqual([
      'Inbox/Call the bank.md',
      'Inbox/Proposals/Ideas.md',
    ]);
  });

  it('says where each meeting stands with the import, and why one failed', async () => {
    const query = atlasQueryIndex({
      markdown: fakeMarkdown(),
      files: {
        'Inbox/Meetings/Waiting.md': '---\ntype: meeting\n---\n',
        'Inbox/Meetings/Broken.md':
          '---\ntype: meeting\natlas_import_outcome: error\natlas_import_error: title is required\n---\n',
        'Inbox/Meetings/Done.md': '---\ntype: meeting\natlas_import_outcome: imported\n---\n',
        'Inbox/Call.md': '---\ntype: task\n---\n',
      },
    });
    const { items } = await listInbox({ index: fakeIndexPort({ query }) });
    const standing = Object.fromEntries(
      items.map((item) => [item.path, [item.importOutcome, item.importError]]),
    );
    expect(standing).toEqual({
      'Inbox/Meetings/Waiting.md': ['pending', null],
      'Inbox/Meetings/Broken.md': ['error', 'title is required'],
      'Inbox/Meetings/Done.md': ['imported', null],
      'Inbox/Call.md': [null, null],
    });
  });

  it('says when there were more than it lists', async () => {
    const query = atlasQueryIndex({
      markdown: fakeMarkdown(),
      files: { 'Inbox/A.md': 'a\n', 'Inbox/B.md': 'b\n' },
    });
    const listing = await listInbox({ index: fakeIndexPort({ query }), limit: 1 });
    expect(listing.items).toHaveLength(1);
    expect(listing.truncated).toBe(true);
  });

  it('reaches every note past a full page, and says how many wait in all (#167)', async () => {
    const query = atlasQueryIndex({
      markdown: fakeMarkdown(),
      files: { 'Inbox/A.md': 'a\n', 'Inbox/B.md': 'b\n', 'Inbox/C.md': 'c\n' },
    });
    const index = fakeIndexPort({ query });

    const first = await listInbox({ index, limit: 2 });
    const rest = await listInbox({ index, limit: 2, after: first.last });

    expect(first).toMatchObject({ truncated: true, total: 3 });
    expect(rest).toMatchObject({ truncated: false, total: 3 });
    expect([...first.items, ...rest.items].map((item) => item.path).sort()).toEqual([
      'Inbox/A.md',
      'Inbox/B.md',
      'Inbox/C.md',
    ]);
  });

  it('counts what it lists when it lists everything', async () => {
    const query = atlasQueryIndex({
      markdown: fakeMarkdown(),
      files: { 'Inbox/A.md': 'a\n', 'Inbox/B.md': 'b\n' },
    });
    expect(await listInbox({ index: fakeIndexPort({ query }) })).toMatchObject({
      truncated: false,
      total: 2,
    });
  });
});

describe('what each item has written, read from a real index (#903)', () => {
  it('carries project and due as written, resolved or not, for the plan to hold as set', async () => {
    const files = {
      'Projects/Larkspur Payroll.md': jsonNote({ type: 'project' }),
      'Areas/Hiring.md': jsonNote({ type: 'area' }),
      'Inbox/Two links.md': jsonNote({
        project: ['[[Larkspur Payroll]]', '[[Hiring]]'],
        due: '2026-12-01',
      }),
      'Inbox/A number.md': jsonNote({ project: 3, due: 'next Friday' }),
      'Inbox/Empty.md': jsonNote({ project: '', due: '' }),
      'Inbox/Dangling.md': jsonNote({ project: '[[Old Payroll]]' }),
      'Inbox/Plain words.md': jsonNote({ project: 'Larkspur Payroll' }),
    };
    const query = atlasQueryIndex({ files, markdown: jsonMarkdown() });
    const { items } = await listInbox({ index: fakeIndexPort({ query }) });
    const of = (title: string) => {
      const item = items.find((each) => each.title === title)!;
      const held = assistHeld(item);
      return { written: item.written, set: [held.project !== null, held.due !== null] };
    };

    expect(of('Two links')).toEqual({
      written: expect.objectContaining({
        project: 'Projects/Larkspur Payroll.md',
        projectNames: ['Larkspur Payroll', 'Hiring'],
        due: '2026-12-01',
        dueWritten: '2026-12-01',
      }),
      set: [true, true],
    });
    expect(of('A number')).toEqual({
      written: expect.objectContaining({
        project: null,
        projectNames: ['3'],
        due: null,
        dueWritten: 'next Friday',
      }),
      set: [true, true],
    });
    expect(of('Empty')).toEqual({
      written: expect.objectContaining({
        project: null,
        projectNames: [],
        due: null,
        dueWritten: '',
      }),
      set: [false, false],
    });
    expect(of('Dangling').written).toMatchObject({ project: null, projectNames: ['Old Payroll'] });
    expect(of('Dangling').set).toEqual([true, false]);
    expect(of('Plain words').written).toMatchObject({
      project: null,
      projectNames: ['Larkspur Payroll'],
    });
    expect(of('Plain words').set).toEqual([true, false]);
  });
});
