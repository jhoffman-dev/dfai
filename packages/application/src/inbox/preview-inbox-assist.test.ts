import { describe, expect, it } from 'vitest';
import { createVaultPath, inboxItem, localTimeMs, type InboxItem } from '@dfai/domain';
import { ModelProviderError, type ProviderStatus } from '../chat/ports.ts';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { previewInboxAssist, type InboxAssistPorts } from './preview-inbox-assist.ts';

/**
 * #900: Suggest asks Claude once, with a fake provider here, and comes back
 * with a plan or says plainly why not. It writes nothing, ever.
 */

const LOCAL_NOW = '2026-11-17T09:00:00';
const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);
const QUIET = NOW - 60 * 60_000;

const item = (title: string, row: Record<string, unknown> = {}): InboxItem =>
  inboxItem({ path: createVaultPath(`Inbox/${title}.md`), title, type: null, ...row });
const CALL = item('Call Mara Quill');
const ARTICLE = item('Payroll article');

const entry = (path: string, extra: Record<string, unknown> = {}) => ({
  item: path,
  kind: 'task',
  projects: ['Projects/Larkspur Payroll.md'],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'It asks for a call.',
  ...extra,
});
const said = (text: string): ScriptedRound => [{ type: 'text', text }];
const answer = (...entries: unknown[]): ScriptedRound => said(JSON.stringify({ items: entries }));

function setUp({
  rounds = [],
  status = { ready: true },
  modified = {},
  unsaved = [],
}: {
  rounds?: readonly ScriptedRound[];
  status?: ProviderStatus;
  modified?: Record<string, number>;
  unsaved?: readonly string[];
} = {}) {
  const model = fakeModel(rounds);
  const writes: string[] = [];
  const write = (name: string) => async () => {
    writes.push(name);
    throw new Error(`${name} was asked for`);
  };
  const reads: string[][] = [];
  const ports: InboxAssistPorts = {
    provider: () => ({ ...model, status: async () => status }),
    deadline: () => new AbortController().signal,
    clock: { now: () => NOW, today: () => '2026-11-17', localNow: () => LOCAL_NOW },
    fs: fakeVaultFs({
      readNotes: async (paths) => {
        reads.push([...paths]);
        return paths.map((path) => ({
          path,
          text: `---\ntype: note\n---\nAbout ${path}\n`,
          modified: modified[path] ?? QUIET,
          size: 40,
        }));
      },
      createNote: write('createNote'),
      createFolder: write('createFolder'),
      moveEntry: write('moveEntry'),
      trashEntry: write('trashEntry'),
      writeTextFile: write('writeTextFile'),
      writeBinaryFile: write('writeBinaryFile'),
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      notesOfType: async (type) =>
        type === 'project'
          ? [{ path: 'Projects/Larkspur Payroll.md', title: 'Larkspur Payroll' }]
          : type === 'person'
            ? [{ path: 'People/Mara Quill.md', title: 'Mara Quill' }]
            : [],
    }) as InboxAssistPorts['index'],
    unsaved: (path) => unsaved.includes(path),
  };
  return { ports, model, writes, reads };
}

describe('previewInboxAssist', () => {
  it('asks once, with no tools, and plans each item from its answer', async () => {
    const { ports, model, writes } = setUp({
      rounds: [answer(entry(CALL.path), entry(ARTICLE.path, { kind: 'junk', projects: [] }))],
    });
    const outcome = await previewInboxAssist(ports, { items: [CALL, ARTICLE], previewed: [] });
    expect(outcome).toMatchObject({
      kind: 'plan',
      summary: '2 items: would file 1, 1 question',
      notConsidered: 0,
    });
    expect(outcome.asked).toBe(localTimeMs(LOCAL_NOW));
    if (outcome.kind !== 'plan') return;
    expect(outcome.rows.map((row) => row.step.kind)).toEqual(['task', 'ask']);
    expect(outcome.rows[0]!.step).toMatchObject({ project: { title: 'Larkspur Payroll' } });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools).toEqual([]);
    expect(model.requests[0]!.model).toBe('claude-sonnet-5-5');
    // The notes are fenced as data, and the projects and people listed beside them.
    expect(model.requests[0]!.system).toContain(`<vault_data note="${CALL.path}">`);
    expect(model.requests[0]!.system).toContain('- Projects/Larkspur Payroll.md');
    expect(writes).toEqual([]);
  });

  it('says plainly when Claude cannot be reached, and asks nothing', async () => {
    const { ports, model } = setUp({
      status: {
        ready: false,
        problem: 'not_logged_in',
        message: 'Claude Code is not logged in.',
        fix: 'claude login',
      },
    });
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    expect(outcome).toEqual({
      kind: 'not-now',
      message:
        'Not now: Claude can’t be reached. Claude Code is not logged in. Fix: claude login Nothing was asked; nothing changed.',
      asked: null,
    });
    expect(model.requests).toHaveLength(0);
  });

  it('says so when the ask itself fails, and counts the ask', async () => {
    const { ports } = setUp({
      rounds: [new ModelProviderError('unavailable', 'The service is busy.')],
    });
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    expect(outcome).toEqual({
      kind: 'not-now',
      message: 'Not now: Claude could not be reached (The service is busy.). Nothing changed.',
      asked: localTimeMs(LOCAL_NOW),
    });
  });

  it('refuses a malformed answer whole', async () => {
    const { ports, writes } = setUp({ rounds: [said('I filed them all for you!')] });
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    expect(outcome).toMatchObject({
      kind: 'not-now',
      message: 'Claude’s answer was not used: It is not JSON. Nothing changed.',
    });
    expect(writes).toEqual([]);
  });

  it('refuses a hostile answer whole: an entry for a note it was not asked about', async () => {
    const { ports } = setUp({
      rounds: [answer(entry(CALL.path), entry('Projects/Larkspur Payroll.md', { kind: 'junk' }))],
    });
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    expect(outcome).toMatchObject({
      kind: 'not-now',
      message:
        'Claude’s answer was not used: An entry is for a note it was not asked about. Nothing changed.',
    });
  });

  it('refuses an answer that reached for a tool', async () => {
    const call = {
      id: 'c1',
      name: 'atlas_write_note',
      input: { path: 'Inbox/Call Mara Quill.md' },
    };
    const { ports, writes } = setUp({ rounds: [[{ type: 'tool_call', call }]] });
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    expect(outcome).toMatchObject({
      kind: 'not-now',
      message:
        'Claude’s answer was not used: it reached for a tool, and Suggest gives it none. Nothing changed.',
    });
    expect(writes).toEqual([]);
  });

  it('asks nothing once the hour’s asks are spent, and says when it can ask again', async () => {
    const { ports, model } = setUp({ rounds: [answer(entry(CALL.path))] });
    const at = localTimeMs(LOCAL_NOW)!;
    const previewed = Array.from({ length: 30 }, (_, n) => at - (59 - n) * 60_000);
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed });
    expect(outcome).toEqual({
      kind: 'not-now',
      message:
        'Not broken: Claude has been asked 30 times this hour, and 30 is the most Suggest and “After a meeting” may ask together. Suggest can ask again at 09:01; nothing to do.',
      asked: null,
    });
    expect(model.requests).toHaveLength(0);
  });

  it('asks about at most ten items, and says how many more were not looked at', async () => {
    const items = Array.from({ length: 13 }, (_, n) => item(`Item ${n}`));
    const asked = items
      .slice(0, 10)
      .map((each) => entry(each.path, { kind: 'note', projects: [] }));
    const { ports, model, reads } = setUp({ rounds: [answer(...asked)] });
    const outcome = await previewInboxAssist(ports, { items, previewed: [] });
    expect(outcome).toMatchObject({
      kind: 'plan',
      summary: '10 items: would leave 10',
      notConsidered: 3,
    });
    expect(reads).toEqual([items.slice(0, 10).map((each) => each.path)]);
    expect(model.requests[0]!.system).not.toContain('Item 10.md');
  });

  it('leaves out, and says why, a meeting, a note with unsaved typing and one changed in the last ten minutes', async () => {
    const meeting = item('Sync', { type: 'meeting' });
    const typing = item('Half written');
    const fresh = item('Just captured');
    const { ports, model } = setUp({
      rounds: [answer(entry(CALL.path))],
      unsaved: [typing.path],
      modified: { [fresh.path]: NOW - 5 * 60_000 },
    });
    const outcome = await previewInboxAssist(ports, {
      items: [meeting, typing, fresh, CALL],
      previewed: [],
    });
    if (outcome.kind !== 'plan') throw new Error(outcome.message);
    expect(outcome.rows.map((row) => row.step)).toEqual([
      { kind: 'leave', because: 'A meeting: “After a meeting” handles it.' },
      { kind: 'leave', because: 'It has typing not saved yet.' },
      { kind: 'leave', because: 'Changed in the last 10 minutes.' },
      expect.objectContaining({ kind: 'task' }),
    ]);
    expect(outcome.summary).toBe('4 items: would file 1, would leave 3');
    const system = model.requests[0]!.system;
    expect(system).toContain(CALL.path);
    expect(system).not.toContain(fresh.path);
    expect(system).not.toContain(typing.path);
  });

  it('asks nothing when every item is left out', async () => {
    const { ports, model } = setUp({ modified: { [CALL.path]: NOW } });
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    expect(outcome).toMatchObject({ kind: 'plan', summary: '1 item: would leave 1', asked: null });
    expect(model.requests).toHaveLength(0);
  });

  it('plans nothing for an empty Inbox', async () => {
    const { ports, model } = setUp();
    const outcome = await previewInboxAssist(ports, { items: [], previewed: [] });
    expect(outcome).toMatchObject({
      kind: 'plan',
      summary: 'Nothing to suggest: no items to look at.',
      rows: [],
    });
    expect(model.requests).toHaveLength(0);
  });

  it('leaves out a note gone since the Inbox was listed', async () => {
    const { ports, model } = setUp();
    ports.fs.readNotes = async () => [];
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    if (outcome.kind !== 'plan') throw new Error(outcome.message);
    expect(outcome.rows[0]!.step).toEqual({ kind: 'leave', because: 'It is no longer there.' });
    expect(model.requests).toHaveLength(0);
  });

  it('says Claude did not finish when the ask is stopped, and counts it', async () => {
    const { ports } = setUp({ rounds: [answer(entry(CALL.path))] });
    const stopped = new AbortController();
    stopped.abort();
    const outcome = await previewInboxAssist(
      { ...ports, deadline: () => stopped.signal },
      { items: [CALL], previewed: [] },
    );
    expect(outcome).toEqual({
      kind: 'not-now',
      message: 'Claude did not finish. Nothing changed.',
      asked: localTimeMs(LOCAL_NOW),
    });
  });

  it('refuses an answer with no words', async () => {
    const { ports } = setUp({ rounds: [[]] });
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    expect(outcome).toMatchObject({
      kind: 'not-now',
      message: 'Claude’s answer was not used: It is not JSON. Nothing changed.',
    });
  });

  it('says what is wrong without a fix when there is none', async () => {
    const { ports } = setUp({
      status: { ready: false, problem: 'unavailable', message: 'Claude is busy.', fix: null },
    });
    const outcome = await previewInboxAssist(ports, { items: [CALL], previewed: [] });
    expect(outcome).toMatchObject({
      message:
        'Not now: Claude can’t be reached. Claude is busy. Nothing was asked; nothing changed.',
    });
  });

  it('lets an unexpected failure through, rather than calling it Claude’s', async () => {
    const { ports } = setUp({ rounds: [new TypeError('a bug')] });
    await expect(previewInboxAssist(ports, { items: [CALL], previewed: [] })).rejects.toThrow(
      'a bug',
    );
  });
});
