import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../automations/run-log.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  apiWriteReport,
  automationEntryReport,
  automationFailedReport,
  chatReport,
  dryRunReport,
  indexFailedReport,
  indexInWindowReport,
  indexRebuiltReport,
  leavesFileUnsettled,
  meetingImportReport,
  meetingImportStoppedReport,
  noticeReport,
  notesNotIndexedReport,
  screenWriteFailedReport,
  sourceRefreshReport,
  writeFailedReport,
} from './activity-reports.ts';
import { activityEvent } from './activity-event.ts';

const p = createVaultPath;
const RULE = { name: 'Tidy tasks', path: p('.atlas/automations/Tidy tasks.md') };
const RULE_SUBJECT = { kind: 'rule', path: RULE.path };
const AT = '2026-09-28T03:00:00';

describe('automationEntryReport', () => {
  const run = (left: number): LogEntry => ({
    kind: 'run',
    at: AT,
    trigger: 'schedule',
    done: [{ kind: 'archived', from: p('Tasks/A.md'), to: p('Archive/Tasks/A.md') }],
    left: Array.from({ length: left }, (_, at) => ({ path: p(`Tasks/L${at}.md`), reason: 'open' })),
    capped: false,
  });

  it('sums up a run in one line, linked to its rule', () => {
    expect(automationEntryReport(RULE, run(0))).toEqual({
      level: 'info',
      kind: 'automation',
      message: 'Tidy tasks: Ran on schedule. Archived 1 note.',
      subject: RULE_SUBJECT,
    });
  });

  it('warns about a run that left notes alone', () => {
    const report = automationEntryReport(RULE, run(2));
    expect(report?.level).toBe('warning');
    expect(report?.message).toBe('Tidy tasks: Ran on schedule. Archived 1 note. Left 2 alone.');
  });

  it('says a run that could not start is an error, and why', () => {
    const failed: LogEntry = { kind: 'failed', at: AT, trigger: 'hand', problem: 'no such type' };
    expect(automationEntryReport(RULE, failed)).toMatchObject({
      level: 'error',
      message: 'Tidy tasks: Ran by hand, and could not. no such type',
    });
  });

  it('sums up an undo', () => {
    const undo: LogEntry = {
      kind: 'undo',
      at: AT,
      of: '2026-09-27T03:00:00',
      done: [{ kind: 'unarchived', from: p('Archive/Tasks/A.md'), to: p('Tasks/A.md') }],
      left: [],
    };
    expect(automationEntryReport(RULE, undo)).toMatchObject({
      level: 'info',
      message: 'Tidy tasks: Undid its last run. Put back 1 note.',
    });
  });

  it('names the notes that set a run off, and not the versions it wrote', () => {
    const noted = (count: number): LogEntry => ({
      kind: 'run',
      at: AT,
      trigger: 'note',
      done: [{ kind: 'archived', from: p('Tasks/A.md'), to: p('Archive/Tasks/A.md') }],
      left: [],
      capped: false,
      versions: [
        ...Array.from({ length: count }, (_, at) => ({
          path: p(`Inbox/Meetings/M${at}.md`),
          digest: `d${at}`,
          wrote: false,
        })),
        { path: p('Archive/Inbox/Meetings/M0.md'), digest: 'x', wrote: true },
      ],
    });
    expect(automationEntryReport(RULE, noted(1))?.message).toBe(
      'Tidy tasks: Ran when a note appeared or changed (M0). Archived 1 note.',
    );
    expect(automationEntryReport(RULE, noted(3))?.message).toBe(
      'Tidy tasks: Ran when a note appeared or changed (M0, M1, M2). Archived 1 note.',
    );
    expect(automationEntryReport(RULE, noted(5))?.message).toBe(
      'Tidy tasks: Ran when a note appeared or changed (M0, M1, M2 and 2 more). Archived 1 note.',
    );
  });

  it('says the notes a run heard beside its rule, each once, and not those it wrote (#192)', () => {
    const heard = (path: string, wrote = false) => ({ path: p(path), digest: 'd', wrote });
    const entry: LogEntry = {
      kind: 'run',
      at: AT,
      trigger: 'note',
      done: [],
      left: [],
      capped: false,
      versions: [
        heard('Inbox/Meetings/M0.md'),
        heard('Inbox/Meetings/M0.md'),
        heard('M1.md', true),
      ],
    };
    expect(automationEntryReport(RULE, entry)?.notes).toEqual(['Inbox/Meetings/M0.md']);
    expect(automationEntryReport(RULE, { ...entry, versions: [] })).not.toHaveProperty('notes');
  });

  it('says nothing of a rule turned on or first seen', () => {
    expect(automationEntryReport(RULE, { kind: 'turnedOn', at: AT })).toBeNull();
    expect(automationEntryReport(RULE, { kind: 'seen', at: AT })).toBeNull();
  });
});

describe('automationFailedReport', () => {
  it('names a run that failed part-way as an error', () => {
    expect(automationFailedReport({ rule: RULE, doing: 'run', problem: 'disk full' })).toEqual({
      level: 'error',
      kind: 'automation',
      message: 'Tidy tasks: Could not run. disk full',
      subject: RULE_SUBJECT,
    });
  });

  it('names a failed undo', () => {
    expect(
      automationFailedReport({ rule: RULE, doing: 'undo', problem: 'log unreadable' }).message,
    ).toBe('Tidy tasks: Could not undo its last run. log unreadable');
  });
});

describe('dryRunReport', () => {
  const plan = (paths: number, passedOver: number, archive = true) => ({
    plan: {
      action: archive
        ? ({ kind: 'archive' } as const)
        : ({ kind: 'set', values: { a: 1 } } as const),
      paths: Array.from({ length: paths }, (_, at) => p(`T/${at}.md`)),
      passedOver: Array.from({ length: passedOver }, (_, at) => ({
        path: p(`L/${at}.md`),
        reason: 'x',
      })),
      capped: false,
    },
  });

  it('says what an archive would do', () => {
    expect(dryRunReport(RULE, plan(3, 0))).toEqual({
      level: 'info',
      kind: 'automation',
      message: 'Tidy tasks: Dry run. Would archive 3 notes.',
      subject: RULE_SUBJECT,
    });
  });

  it('says what a change would do, and what it would leave', () => {
    expect(dryRunReport(RULE, plan(1, 2, false)).message).toBe(
      'Tidy tasks: Dry run. Would change 1 note, and leave 2 alone.',
    );
  });

  it('says when there is nothing to do', () => {
    expect(dryRunReport(RULE, plan(0, 0)).message).toBe('Tidy tasks: Dry run. Nothing to do.');
  });

  it('links a draft not yet saved to nothing', () => {
    expect(dryRunReport({ name: 'New rule', path: null }, plan(0, 0)).subject).toBeNull();
  });

  it('warns when its query did not read', () => {
    expect(dryRunReport(RULE, { problem: 'unknown field' })).toMatchObject({
      level: 'warning',
      message: 'Tidy tasks: Dry run could not read its notes. unknown field',
    });
  });
});

describe('sourceRefreshReport', () => {
  const ok = { records: 12, created: 2, replaced: 1, updated: 3, missing: 1, error: null };
  const SOURCE = p('Sources/GitHub issues.md');

  it('names the source by its note, with what changed', () => {
    expect(sourceRefreshReport(SOURCE, ok)).toEqual({
      level: 'info',
      kind: 'source',
      message: 'GitHub issues: Refreshed. 12 records, 2 new, 4 updated, 1 gone from the feed.',
      subject: { kind: 'source', path: SOURCE },
    });
  });

  it('says when nothing changed', () => {
    const same = { ...ok, records: 1, created: 0, replaced: 0, updated: 0, missing: 0 };
    expect(sourceRefreshReport(SOURCE, same).message).toBe(
      'GitHub issues: Refreshed. 1 record, nothing changed.',
    );
  });

  it('says a failed refresh is an error, and why', () => {
    expect(sourceRefreshReport(SOURCE, { ...ok, error: 'HTTP 500' })).toMatchObject({
      level: 'error',
      message: 'GitHub issues: Refresh failed. HTTP 500',
    });
  });
});

describe('apiWriteReport', () => {
  const NOTE = p('Projects/DFAI.md');

  it('keeps its route once the line is made safe, which strikes out anything path-shaped', () => {
    const report = apiWriteReport({
      route: 'PUT /v1/notes/{path}/body',
      notePath: NOTE,
      refusal: null,
    });
    expect(activityEvent({ ...report, at: 1 }).message).toBe('PUT v1/notes/{path}/body — DFAI');
  });

  it('names the route and the note written, not what was written', () => {
    expect(
      apiWriteReport({ route: 'PUT /v1/notes/{path}/body', notePath: NOTE, refusal: null }),
    ).toEqual({
      level: 'info',
      kind: 'api',
      message: 'PUT v1/notes/{path}/body — DFAI',
      subject: { kind: 'note', path: NOTE },
    });
  });

  it('names a write with no one note', () => {
    expect(apiWriteReport({ route: 'POST /v1/archive', notePath: null, refusal: null })).toEqual({
      level: 'info',
      kind: 'api',
      message: 'POST v1/archive',
      subject: null,
    });
  });

  it('warns of a refused write, with why', () => {
    expect(
      apiWriteReport({ route: 'PUT /v1/notes/{path}/body', notePath: NOTE, refusal: 'conflict' }),
    ).toMatchObject({
      level: 'warning',
      message: 'PUT v1/notes/{path}/body refused for DFAI (conflict).',
    });
    expect(
      apiWriteReport({ route: 'POST /v1/archive', notePath: null, refusal: 'bad_request' }).message,
    ).toBe('POST v1/archive refused (bad_request).');
  });
});

describe('chatReport', () => {
  const NOTE = p('Ideas/Garden.md');
  const NOTE_SUBJECT = { kind: 'note', path: NOTE };

  it('records an accepted edit and an accepted new note', () => {
    expect(chatReport({ kind: 'accepted', path: NOTE, created: false })).toEqual({
      level: 'info',
      kind: 'chat',
      message: 'Edited Garden, as Claude proposed.',
      subject: NOTE_SUBJECT,
    });
    expect(chatReport({ kind: 'accepted', path: NOTE, created: true }).message).toBe(
      'Created Garden, as Claude proposed.',
    );
  });

  it('records an undo', () => {
    expect(chatReport({ kind: 'undone', path: NOTE })).toMatchObject({
      level: 'info',
      message: "Undid Claude's change to Garden.",
      subject: NOTE_SUBJECT,
    });
  });

  it('warns of a refused Accept or Undo', () => {
    expect(
      chatReport({ kind: 'refused', doing: 'accept', path: NOTE, problem: 'It changed since.' }),
    ).toMatchObject({
      level: 'warning',
      message: "Could not accept Claude's change to Garden. It changed since.",
    });
    expect(
      chatReport({ kind: 'refused', doing: 'undo', path: NOTE, problem: 'Edited since.' }).message,
    ).toBe("Could not undo Claude's change to Garden. Edited since.");
  });

  it.each([
    ['not_installed', 'Claude could not answer: Claude Code is not installed.'],
    ['not_logged_in', 'Claude could not answer: Claude Code is not signed in.'],
    ['no_key', 'Claude could not answer: no API key is set.'],
    ['unavailable', 'Claude could not answer: the service could not be reached.'],
  ] as const)('says a turn failed for want of %s in fixed words', (reason, message) => {
    expect(chatReport({ kind: 'turnFailed', reason }).message).toBe(message);
  });

  it('records a failed turn and an unsaved chat as errors, with no subject', () => {
    expect(chatReport({ kind: 'turnFailed', reason: 'failed' })).toEqual({
      level: 'error',
      kind: 'chat',
      message: 'Claude could not answer.',
      subject: null,
    });
    expect(chatReport({ kind: 'notKept' })).toEqual({
      level: 'error',
      kind: 'chat',
      message: 'The chat could not be saved to Chats/.',
      subject: null,
    });
  });
});

describe('index, save and notice reports', () => {
  it('records a rebuild with its count', () => {
    expect(indexRebuiltReport(1).message).toBe('Rebuilt the index: 1 note.');
    expect(indexRebuiltReport(40)).toEqual({
      level: 'info',
      kind: 'index',
      message: 'Rebuilt the index: 40 notes.',
      subject: null,
    });
  });

  it('records an index failure as an error', () => {
    expect(indexFailedReport({ rebuilding: true, problem: 'locked' })).toMatchObject({
      level: 'error',
      message: 'The index could not be rebuilt. locked',
    });
    expect(indexFailedReport({ rebuilding: false, problem: 'locked' }).message).toBe(
      'The index could not be brought up to date. locked',
    );
  });

  it('records that the index is being built in the window, and why (#135)', () => {
    expect(indexInWindowReport('The worker could not be started.')).toEqual({
      level: 'warning',
      kind: 'index',
      message:
        'Indexing in the window, which is slower: the background indexer could not be used. The worker could not be started.',
      subject: null,
    });
  });

  it('records the notes a build could not index, linked to the first (#135)', () => {
    expect(
      notesNotIndexedReport([
        { path: 'Torn.md', problem: 'unexpected end of note' },
        { path: 'Frayed.md', problem: 'bad escape' },
      ]),
    ).toEqual({
      level: 'warning',
      kind: 'index',
      message: '2 notes could not be indexed. The first is Torn.md: unexpected end of note',
      subject: { kind: 'note', path: 'Torn.md' },
    });
    expect(notesNotIndexedReport([{ path: 'Torn.md', problem: 'cut short' }]).message).toBe(
      '1 note could not be indexed. The first is Torn.md: cut short',
    );
  });

  it('records a failed save, linked to the note', () => {
    expect(
      writeFailedReport({ write: 'save', path: p('Inbox.md'), problem: 'changed on disk' }),
    ).toEqual({
      level: 'error',
      kind: 'save',
      message: 'Could not save Inbox.md. changed on disk',
      subject: { kind: 'note', path: 'Inbox.md' },
    });
  });

  it('records other failed writes without a link to what may no longer be there', () => {
    const moved = writeFailedReport({ write: 'move', path: p('A.md'), problem: 'exists' });
    expect(moved.message).toBe('Could not move A.md. exists');
    expect(moved.subject).toBeNull();
    expect(writeFailedReport({ write: 'trash', path: p('A.md'), problem: 'x' }).message).toBe(
      'Could not move to the Trash A.md. x',
    );
    expect(writeFailedReport({ write: 'createFolder', path: p('F'), problem: 'x' }).message).toBe(
      'Could not create the folder F. x',
    );
    expect(writeFailedReport({ write: 'writeFile', path: p('a.png'), problem: 'x' }).message).toBe(
      'Could not write a.png. x',
    );
    expect(
      writeFailedReport({ write: 'create', path: p('N.md'), problem: 'x' }).subject,
    ).toBeNull();
  });

  it('records a write a screen gave up on, linked to the note it was writing', () => {
    expect(
      screenWriteFailedReport({ write: 'edit', path: p('Tasks/Call.md'), problem: 'locked' }),
    ).toEqual({
      level: 'error',
      kind: 'save',
      message: 'Could not save an edit — Call. locked',
      subject: { kind: 'note', path: 'Tasks/Call.md' },
    });
  });

  it('records a write with no note yet without a name or a link', () => {
    expect(screenWriteFailedReport({ write: 'view', path: null, problem: 'disk full' })).toEqual({
      level: 'error',
      kind: 'save',
      message: 'Could not save the view. disk full',
      subject: null,
    });
  });

  it.each([
    ['dashboard', 'Could not add the query to the dashboard'],
    ['card', 'Could not add the card'],
    ['image', 'Could not add the image'],
    ['artifact', 'Could not save the artifact'],
    ['setting', 'Could not save a setting'],
    ['connection', 'Could not change the API connection'],
  ] as const)('says what a %s write was doing when it gave up', (write, words) => {
    expect(screenWriteFailedReport({ write, path: null, problem: 'x' }).message).toBe(
      `${words}. x`,
    );
  });

  it('records a red notice as an error of the app', () => {
    expect(noticeReport('The sidebar could not be saved')).toEqual({
      level: 'error',
      kind: 'app',
      message: 'The sidebar could not be saved',
      subject: null,
    });
    expect(noticeReport('Unsaved changes were kept', 'warning').level).toBe('warning');
  });
});

describe('meetingImportReport', () => {
  const standup = p('Inbox/Meetings/2026-10-06 Standup.md');
  const original = p('Projects/Larkspur/2026-10-06 Standup.md');

  it('says a meeting arrived, linking to it, as a meeting line', () => {
    expect(meetingImportReport({ kind: 'arrived', path: standup })).toEqual({
      level: 'info',
      kind: 'meeting',
      message: '2026-10-06 Standup: arrived in the Inbox.',
      subject: { kind: 'note', path: standup },
    });
  });

  it('says an import error was taken out once the file reads', () => {
    const report = meetingImportReport({ kind: 'fixed', path: standup });
    expect(report.level).toBe('info');
    expect(report.message).toBe(
      '2026-10-06 Standup: now follows the import contract, so its import error was taken out.',
    );
  });

  it('warns of a file that breaks the contract, with why, and whether that is in the file', () => {
    expect(
      meetingImportReport({
        kind: 'invalid',
        path: standup,
        problem: 'external_id is required',
        unmarked: null,
      }),
    ).toEqual({
      level: 'warning',
      kind: 'meeting',
      message: '2026-10-06 Standup: could not be imported. external_id is required',
      subject: { kind: 'note', path: standup },
    });
    expect(
      meetingImportReport({
        kind: 'invalid',
        path: standup,
        problem: 'The frontmatter is not readable YAML',
        unmarked: 'its frontmatter cannot be read',
      }).message,
    ).toBe(
      '2026-10-06 Standup: could not be imported. The problem is not in the file: its frontmatter cannot be read. The frontmatter is not readable YAML',
    );
  });

  it('names the original of a duplicate, and links to where the copy was archived', () => {
    const archived = p('Archive/Inbox/Meetings/2026-10-06 Standup.md');
    expect(
      meetingImportReport({
        kind: 'duplicate',
        path: standup,
        of: original,
        archivedTo: archived,
        problem: null,
      }),
    ).toEqual({
      level: 'info',
      kind: 'meeting',
      message: '2026-10-06 Standup: a second copy of 2026-10-06 Standup, so it was archived.',
      subject: { kind: 'note', path: archived },
    });
  });

  it('warns of a copy that could not be archived, linking to where it still is', () => {
    expect(
      meetingImportReport({
        kind: 'duplicate',
        path: standup,
        of: original,
        archivedTo: null,
        problem: 'It is open in DFAI with unsaved typing.',
      }),
    ).toEqual({
      level: 'warning',
      kind: 'meeting',
      message:
        '2026-10-06 Standup: a second copy of 2026-10-06 Standup, but it could not be archived. It is open in DFAI with unsaved typing. It is tried again when it next changes.',
      subject: { kind: 'note', path: standup },
    });
  });

  it('warns of a duplicate archived with a problem on the way, linking to where it went', () => {
    const archived = p('Archive/Inbox/Meetings/2026-10-06 Standup.md');
    expect(
      meetingImportReport({
        kind: 'duplicate',
        path: standup,
        of: original,
        archivedTo: archived,
        problem: 'Moved, but its frontmatter was not updated.',
      }),
    ).toEqual({
      level: 'warning',
      kind: 'meeting',
      message:
        '2026-10-06 Standup: a second copy of 2026-10-06 Standup, so it was archived. Moved, but its frontmatter was not updated.',
      subject: { kind: 'note', path: archived },
    });
  });

  it('says an import that could not finish as an error', () => {
    expect(
      meetingImportReport({ kind: 'failed', path: standup, problem: 'The index is closed.' }),
    ).toEqual({
      level: 'error',
      kind: 'meeting',
      message: '2026-10-06 Standup: could not be imported. The index is closed.',
      subject: { kind: 'note', path: standup },
    });
  });
});

describe('meetingImportReport: a sync conflict copy', () => {
  it("warns that it is the person's to compare, and is not imported", () => {
    const copy = createVaultPath('Inbox/Meetings/2026-10-06 Standup (conflict from Mara’s Mac).md');
    expect(meetingImportReport({ kind: 'conflict', path: copy })).toEqual({
      level: 'warning',
      kind: 'meeting',
      message:
        "2026-10-06 Standup (conflict from Mara’s Mac): another Mac's version of a meeting both changed, kept beside it. Compare the two, keep what you want, and delete the copy; it is not imported.",
      subject: { kind: 'note', path: copy },
    });
  });
});

describe('meetingImportStoppedReport', () => {
  it('says an import that could not run at all as an error about no one file', () => {
    expect(meetingImportStoppedReport('The vault was closed.')).toEqual({
      level: 'error',
      kind: 'meeting',
      message: 'Meetings that arrived could not be imported. The vault was closed.',
      subject: null,
    });
  });
});

describe('leavesFileUnsettled: what the import says once a session (#174)', () => {
  const at = p('Inbox/Meetings/2026-10-14 Standup.md');

  it('is true of a file every catch-up meets again as it was', () => {
    const unsettled = [
      { kind: 'conflict', path: at },
      { kind: 'failed', path: at, problem: 'cannot read' },
      { kind: 'invalid', path: at, problem: 'no id', unmarked: 'its frontmatter cannot be read' },
      { kind: 'duplicate', path: at, of: at, archivedTo: null, problem: 'the move failed' },
    ] as const;
    for (const happening of unsettled) expect(leavesFileUnsettled(happening)).toBe(true);
  });

  it('is false of a file the import settled, or marked with its problem', () => {
    const settled = [
      { kind: 'arrived', path: at },
      { kind: 'fixed', path: at },
      { kind: 'invalid', path: at, problem: 'no id', unmarked: null },
      { kind: 'duplicate', path: at, of: at, archivedTo: p('Archive/x.md'), problem: null },
    ] as const;
    for (const happening of settled) expect(leavesFileUnsettled(happening)).toBe(false);
  });
});
