/**
 * #909: applying Inbox assist's rows by hand, and undoing them, over a vault
 * held in memory whose index answers with real SQL. Each row is previewed by
 * the real preview with a scripted Claude, then applied: what is asserted is
 * every note's bytes afterwards. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  inboxItem,
  logPathFor,
  parseAssistLog,
  parseRunLog,
  digestOf,
  type AssistEvidence,
  type AssistRow,
  type InboxItem,
  type VaultPath,
} from '@dfai/domain';
import { automationVault } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeModel } from '../testing/fake-model.ts';
import { seededRandom } from '@dfai/domain/testing';
import {
  applyAssistRow,
  applySureRows,
  type ApplyAssistPorts,
  type AssistApplied,
} from './apply-inbox-assist.ts';
import { INBOX_ASSIST_RULE } from './assist-log.ts';
import { previewInboxAssist } from './preview-inbox-assist.ts';
import { undoAssistRow, undoAssistRows } from './undo-inbox-assist.ts';
import { findUnfinishedAssist } from './assist-unfinished.ts';
import { appendToRuleLog } from '../automations/automation-log.ts';

const TODAY = '2026-11-17';
const NOON = Date.parse(`${TODAY}T12:00:00Z`);
const CLOCK = {
  now: () => NOON + 60 * 60_000,
  today: () => TODAY,
  localNow: () => `${TODAY}T13:00:00`,
};
const LOG = logPathFor(INBOX_ASSIST_RULE.id);

const json = (frontmatter: Record<string, unknown>, body = '') =>
  `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;

const PROJECT = 'Projects/Larkspur Payroll.md';
const MARA = 'People/Mara Quill.md';
const KEPT = 'Tasks/Renew Larkspur contract.md';
const CALL = 'Inbox/Call Mara.md';
const ARTICLE = 'Inbox/Payroll article.md';
const LUNCH = 'Inbox/Lunch with Tobias.md';
const RENEW = 'Inbox/Renew Larkspur contract.md';
const JUNK = 'Inbox/Buy now.md';

const VAULT: Record<string, string> = {
  [PROJECT]: json({ type: 'project', para: 'project', status: 'active' }, '\n# Larkspur Payroll\n'),
  [MARA]: json({ type: 'person', email: 'mara.quill@example.com' }),
  [KEPT]: json({ type: 'task', status: 'next-action' }, '\nRenew it.\n'),
  [CALL]: 'Call Mara Quill <mara.quill@example.com> about the renewal by 2026-12-01.\n',
  [ARTICLE]: 'https://example.com/payroll\r\n\r\nA piece on payroll.\r\n',
  [LUNCH]: 'Lunch with Tobias Fenn <tobias@example.org> on Friday.\n',
  [RENEW]: '',
  [JUNK]: 'Buy now!\n',
};

const entry = (item: string, extra: Record<string, unknown> = {}) => ({
  item,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'Something to do.',
  duplicateOf: null,
  people: [],
  ...extra,
});
const ANSWERS = [
  entry(CALL, {
    projects: [PROJECT],
    due: '2026-12-01',
    people: [{ name: 'Mara Quill', email: null, person: MARA }],
  }),
  entry(ARTICLE, { kind: 'reference', projects: [PROJECT] }),
  entry(LUNCH, { people: [{ name: 'Tobias Fenn', email: 'tobias@example.org', person: null }] }),
  entry(RENEW, { duplicateOf: KEPT }),
  entry(JUNK, { kind: 'junk' }),
];

const item = (path: string): InboxItem =>
  inboxItem({ path: createVaultPath(path), title: path.slice('Inbox/'.length, -3), type: null });

type Failing = { method: 'createNote' | 'writeTextFile' | 'moveEntry'; nth: number };

/** The vault, its ports as Apply is handed them, and a way to fail one write. */
function setUp(notes: Record<string, string> = VAULT) {
  const vault = automationVault({ notes, today: TODAY });
  const activity = recordingActivity();
  let failing: Failing | null = null;
  const counts = { createNote: 0, writeTextFile: 0, moveEntry: 0 };
  const failOn = <K extends Failing['method']>(method: K) =>
    (async (args: never) => {
      // The log's own writes are not counted: the failures are of the row's writes to notes.
      const at =
        (args as { path?: string; from?: string }).path ?? (args as { from?: string }).from;
      if (at !== LOG) counts[method] += 1;
      if (at !== LOG && failing?.method === method && failing.nth === counts[method])
        throw new Error(`the disk refused the ${method}`);
      return (vault.ports.fs[method] as (args: never) => Promise<unknown>)(args);
    }) as ApplyAssistPorts['fs'][K];
  const index = vault.ports.index;
  const ports: ApplyAssistPorts = {
    fs: {
      ...vault.ports.fs,
      createNote: failOn('createNote'),
      writeTextFile: failOn('writeTextFile'),
      moveEntry: failOn('moveEntry'),
    },
    markdown: vault.ports.markdown,
    editors: vault.ports.editors,
    index: {
      ...index,
      notesOfType: async (type) =>
        // The in-memory index keeps each note's type with its properties.
        (
          await index.query(
            "SELECT f.path, f.title FROM files f JOIN props p ON p.path = f.path AND p.key = 'type' WHERE p.value_text = ?",
            [type],
          )
        ).rows.map(([path, title]) => ({ path: String(path), title: String(title) })),
    },
    clock: CLOCK,
    activity,
  };
  const notePaths = () => [...vault.files.keys()].map((path) => createVaultPath(path));
  const preview = async (
    answers: readonly unknown[] = ANSWERS,
    paths = Object.keys(VAULT).filter((at) => at.startsWith('Inbox/')),
  ) => {
    const model = fakeModel([[{ type: 'text', text: JSON.stringify({ items: answers }) }]]);
    const outcome = await previewInboxAssist(
      {
        ...ports,
        provider: () => ({ ...model, status: async () => ({ ready: true }) }),
        deadline: () => new AbortController().signal,
        unsaved: (path) => vault.unsaved.has(path),
        recordAsk: () => undefined,
      },
      { items: paths.map(item), previewed: [] },
    );
    if (outcome.kind !== 'plan') throw new Error(`no plan: ${outcome.message}`);
    const evidence = new Map(outcome.evidence.map((each) => [each.item.path, each]));
    const rows = outcome.rows.map((row) => ({ row, evidence: evidence.get(row.path) }));
    return { rows, of: (path: string) => rows.find((each) => each.row.path === path)! };
  };
  const apply = async (path: string, previewed?: Awaited<ReturnType<typeof preview>>) => {
    const { row, evidence } = (previewed ?? (await preview())).of(path);
    return (await applyAssistRow(ports, { row, evidence, notePaths: notePaths() })).applied;
  };
  const snapshot = () => new Map(vault.files);
  return {
    vault,
    ports,
    activity,
    files: vault.files,
    notePaths,
    preview,
    apply,
    snapshot,
    fail: (next: Failing | null) => {
      failing = next;
      counts.createNote = counts.writeTextFile = counts.moveEntry = 0;
    },
    undo: (applied: AssistApplied) => {
      if (applied.kind !== 'applied') throw new Error(`not applied: ${applied.words}`);
      return undoAssistRow(ports, { undo: applied.undo, notePaths: notePaths() });
    },
  };
}

/** Every note but the log, which records each apply and undo by design. */
const notesBut = (files: ReadonlyMap<string, string>) =>
  new Map([...files].filter(([path]) => path !== LOG));

const appliedOf = (applied: AssistApplied) => {
  if (applied.kind !== 'applied') throw new Error(`not applied: ${applied.words}`);
  return applied;
};

describe('applyAssistRow: each kind of row', () => {
  it('makes a task, files it under its project with its due date, links Mara, and undoes it byte for byte', async () => {
    const v = setUp();
    const before = v.snapshot();
    const applied = appliedOf(await v.apply(CALL));
    expect(applied.words).toBe(
      'Made it a task under Larkspur Payroll, due 2026-12-01. Linked Mara Quill.',
    );
    expect(v.files.has(CALL)).toBe(false);
    const filed = v.files.get(applied.path)!;
    expect(JSON.parse(filed.split('\n')[1]!)).toEqual({
      type: 'task',
      status: 'inbox',
      due: '2026-12-01',
      project: '[[Larkspur Payroll]]',
      people: ['[[Mara Quill]]'],
    });
    expect(filed.endsWith(VAULT[CALL]!)).toBe(true);
    // One log entry, one Activity line.
    const [logged] = parseRunLog(v.files.get(LOG)!);
    expect(logged).toMatchObject({
      kind: 'run',
      trigger: 'hand',
      done: [{ kind: 'assisted', from: CALL, to: applied.path }],
    });
    expect(v.activity.reports).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'Inbox assist applied “Call Mara”: Clarified 1 Inbox item.',
      }),
    ]);

    const undone = await v.undo(applied);
    expect(undone).toMatchObject({ kind: 'undone', path: CALL });
    expect(notesBut(v.files)).toEqual(notesBut(before));
    expect(parseRunLog(v.files.get(LOG)!).map((each) => each.kind)).toEqual(['run', 'undo']);
    expect(v.activity.reports).toHaveLength(2);
  });

  it('files a note under its project, CRLF and all, and undoes it', async () => {
    const v = setUp();
    const before = v.snapshot();
    const applied = appliedOf(await v.apply(ARTICLE));
    expect(applied.words).toBe('Filed it under Larkspur Payroll.');
    expect(applied.path).toMatch(/^Notes\/2026\//u);
    expect(v.files.get(applied.path)!.endsWith(VAULT[ARTICLE]!)).toBe(true);
    await v.undo(applied);
    expect(notesBut(v.files)).toEqual(notesBut(before));
  });

  it('adds Tobias Fenn with his address, links him, and undoing takes him out unchanged', async () => {
    const v = setUp();
    const before = v.snapshot();
    const applied = appliedOf(await v.apply(LUNCH));
    expect(applied.words).toBe('Made it a task. Added Tobias Fenn.');
    const person = v.files.get('People/Tobias Fenn.md')!;
    expect(JSON.parse(person.split('\n')[1]!)).toMatchObject({
      type: 'person',
      email: 'tobias@example.org',
    });
    expect(JSON.parse(v.files.get(LUNCH)!.split('\n')[1]!)).toMatchObject({
      people: ['[[Tobias Fenn]]'],
    });
    expect(applied.undo.made).toEqual([
      expect.objectContaining({ path: 'People/Tobias Fenn.md', text: person }),
    ]);

    expect(await v.undo(applied)).toMatchObject({ kind: 'undone' });
    expect(notesBut(v.files)).toEqual(notesBut(before));
    expect(v.vault.log).toContain('trash People/Tobias Fenn.md');
  });

  it('archives the Inbox copy of a duplicate, stamped, never touching the kept task, and undoes it', async () => {
    const v = setUp();
    const before = v.snapshot();
    const applied = appliedOf(await v.apply(RENEW));
    expect(applied.words).toBe('Archived as a duplicate of Renew Larkspur contract.');
    expect(applied.path).toMatch(/^Archive\//u);
    // Linked by path: the copy itself has the kept task's title.
    expect(applied.path).toBe(`Archive/${RENEW}`);
    expect(JSON.parse(v.files.get(applied.path)!.split('\n')[1]!)).toMatchObject({
      atlas_duplicate_of: '[[Tasks/Renew Larkspur contract]]',
    });
    expect(v.files.get(KEPT)).toBe(VAULT[KEPT]);
    expect(v.vault.log.filter((line) => line.includes(KEPT))).toEqual([]);
    await v.undo(applied);
    expect(notesBut(v.files)).toEqual(notesBut(before));
  });

  it('never applies a question', async () => {
    const v = setUp();
    const before = v.snapshot();
    expect(await v.apply(JUNK)).toEqual({
      kind: 'failed',
      words: 'Not applied: It is a question, and questions are never applied. Nothing changed.',
    });
    expect(v.files).toEqual(before);
    expect(v.activity.reports).toEqual([]);
  });
});

describe('applyAssistRow: it asks, and writes nothing, when the notes moved on', () => {
  it('asks once the item was edited after the preview', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.files.set(CALL, `${VAULT[CALL]!}Bring the letter.\n`);
    const before = v.snapshot();
    expect(await v.apply(CALL, previewed)).toMatchObject({ kind: 'asked', ask: 'item-changed' });
    expect(v.files).toEqual(before);
  });

  it('asks once a field it would fill was set by hand', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.files.set(CALL, json({ due: '2026-12-05' }, VAULT[CALL]));
    expect(await v.apply(CALL, previewed)).toMatchObject({ kind: 'asked', ask: 'field-written' });
  });

  it('asks while the item has typing not saved', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.vault.unsaved.add(CALL);
    expect(await v.apply(CALL, previewed)).toMatchObject({ kind: 'asked', ask: 'unsaved' });
  });

  it('asks once the kept task changed', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.files.set(KEPT, `${VAULT[KEPT]!}And call them.\n`);
    expect(await v.apply(RENEW, previewed)).toMatchObject({ kind: 'asked', ask: 'kept-changed' });
    expect(v.files.has(RENEW)).toBe(true);
  });

  it('asks once the person to add is in People', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.files.set('People/Tobias Fenn.md', json({ type: 'person', email: 'tobias@example.org' }));
    expect(await v.apply(LUNCH, previewed)).toMatchObject({ kind: 'asked', ask: 'person-exists' });
  });
});

describe('applyAssistRow: a write that fails midway leaves no half-applied row', () => {
  const cases: { row: string; fail: Failing; says: RegExp }[] = [
    { row: CALL, fail: { method: 'writeTextFile', nth: 1 }, says: /Nothing was left changed\.$/u },
    { row: CALL, fail: { method: 'moveEntry', nth: 1 }, says: /Nothing was left changed\.$/u },
    { row: CALL, fail: { method: 'writeTextFile', nth: 2 }, says: /Nothing was left changed\.$/u },
    { row: LUNCH, fail: { method: 'writeTextFile', nth: 1 }, says: /Nothing was left changed\.$/u },
    { row: LUNCH, fail: { method: 'createNote', nth: 1 }, says: /Nothing was left changed\.$/u },
    {
      row: LUNCH,
      fail: { method: 'writeTextFile', nth: 2 },
      says: /Tobias Fenn was added, then taken out again \(in the Trash\)\. Nothing was left changed\.$/u,
    },
    { row: RENEW, fail: { method: 'writeTextFile', nth: 1 }, says: /Nothing was left changed\.$/u },
    { row: RENEW, fail: { method: 'moveEntry', nth: 1 }, says: /Nothing was left changed\.$/u },
    { row: RENEW, fail: { method: 'writeTextFile', nth: 2 }, says: /Nothing was left changed\.$/u },
  ];
  for (const { row, fail, says } of cases) {
    it(`${row}: the ${fail.method} #${fail.nth} fails`, async () => {
      const v = setUp();
      const previewed = await v.preview();
      const before = v.snapshot();
      v.fail(fail);
      const applied = await v.apply(row, previewed);
      expect(applied).toMatchObject({ kind: 'failed', words: expect.stringMatching(says) });
      expect(notesBut(v.files)).toEqual(notesBut(before));
      // The row it began is closed, so no crash is ever read into it.
      const closing = parseRunLog(v.files.get(LOG)!).at(-1);
      expect(closing).toMatchObject({ kind: 'failed', row: expect.stringContaining(row) });
      expect(closing).not.toHaveProperty('done');
      expect(v.activity.reports).toEqual([
        expect.objectContaining({
          level: 'warning',
          message: expect.stringContaining('could not apply'),
        }),
      ]);
    });
  }

  it('says what it could not take back, and logs it, when the undo of a failed row is refused too', async () => {
    const v = setUp();
    const previewed = await v.preview();
    // The link write fails, and so does every write after: the clarified note cannot be put back.
    v.fail({ method: 'writeTextFile', nth: 2 });
    const failingFrom = v.ports.fs.writeTextFile;
    let calls = 0;
    v.ports.fs.writeTextFile = async (write) => {
      if (write.path !== LOG) calls += 1;
      if (write.path !== LOG && calls >= 2) throw new Error('the disk is full');
      return failingFrom(write);
    };
    const applied = await v.apply(CALL, previewed);
    expect(applied).toMatchObject({
      kind: 'failed',
      words: expect.stringContaining('It was left as the row changed it'),
    });
    // What was left changed is in the log, so it is not lost.
    expect(parseRunLog(v.files.get(LOG)!)).toEqual([
      expect.objectContaining({
        kind: 'failed',
        done: [expect.objectContaining({ kind: 'assisted', from: CALL })],
      }),
    ]);
  });
});

describe('applyAssistRow: what it says when the vault does not answer', () => {
  it('writes nothing when it cannot log that it begins', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const create = v.ports.fs.createNote;
    v.ports.fs.createNote = async (note) => {
      if (note.path === LOG) throw new Error('the disk is full');
      return create(note);
    };
    const before = v.snapshot();
    expect(await v.apply(CALL, previewed)).toEqual({
      kind: 'failed',
      words: 'Not applied: its log could not be written. Nothing changed.',
    });
    expect(v.files).toEqual(before);
  });

  it('keeps what it did, and says so, when only its closing entry cannot be written', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const write = v.ports.fs.writeTextFile;
    v.ports.fs.writeTextFile = async (each) => {
      if (each.path === LOG) throw new Error('the disk is full');
      return write(each);
    };
    const applied = appliedOf(await v.apply(CALL, previewed));
    expect(applied.logged).toBe(false);
    expect(applied.words).toMatch(/Its log could not be written\.$/u);
    expect(v.activity.reports).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('Its log could not be written.'),
      }),
    ]);
    // Its undo does not rest on the log; the begun row is what a person reads after.
    v.ports.fs.writeTextFile = write;
    expect(await v.undo(applied)).toMatchObject({ kind: 'undone' });
    expect(v.files.get(CALL)).toBe(VAULT[CALL]);
  });

  it('writes nothing, and says why, when the vault cannot be read to check it', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const before = v.snapshot();
    Object.assign(v.ports, {
      index: {
        ...v.ports.index,
        query: async () => {
          throw new Error('the index is closed');
        },
      },
    });
    expect(await v.apply(CALL, previewed)).toEqual({
      kind: 'failed',
      words: 'Not applied: it could not be checked (the index is closed). Nothing changed.',
    });
    expect(v.files).toEqual(before);
  });
});

describe('applySureRows', () => {
  it('applies each sure row on its own, skips questions, and goes on past one that asks', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.files.set(ARTICLE, `${VAULT[ARTICLE]!}Edited.\r\n`);
    const seen: string[] = [];
    const results = await applySureRows(v.ports, {
      rows: previewed.rows,
      notePaths: v.notePaths(),
      onEach: ({ path }) => void seen.push(path),
    });
    expect(results.map(({ path, applied }) => [path, applied.kind])).toEqual([
      [CALL, 'applied'],
      [ARTICLE, 'asked'],
      [LUNCH, 'applied'],
      [RENEW, 'applied'],
    ]);
    expect(seen).toEqual([CALL, ARTICLE, LUNCH, RENEW]);
    expect(v.files.get(JUNK)).toBe(VAULT[JUNK]);
  });

  it('stops cleanly once aborted: the row it is on finishes, no other starts', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const controller = new AbortController();
    const results = await applySureRows(v.ports, {
      rows: previewed.rows,
      notePaths: v.notePaths(),
      signal: controller.signal,
      onEach: () => controller.abort(),
    });
    expect(results.map(({ path }) => path)).toEqual([CALL]);
    expect(v.files.get(LUNCH)).toBe(VAULT[LUNCH]);
  });

  it('a failed row never blocks the next', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.fail({ method: 'moveEntry', nth: 1 });
    const results = await applySureRows(v.ports, {
      rows: previewed.rows,
      notePaths: v.notePaths(),
    });
    expect(results.map(({ applied }) => applied.kind)).toEqual([
      'failed',
      'applied',
      'applied',
      'applied',
    ]);
  });
});

describe('undo', () => {
  it('refuses once the item was edited since, leaving the edit as it is', async () => {
    const v = setUp();
    const applied = appliedOf(await v.apply(CALL));
    const edited = `${v.files.get(applied.path)!}My own line.\n`;
    v.files.set(applied.path, edited);
    const undone = await v.undo(applied);
    expect(undone).toEqual({
      kind: 'refused',
      words: 'Not undone: it was changed since, so it was left as it is.',
    });
    expect(v.files.get(applied.path)).toBe(edited);
    expect(v.files.has(CALL)).toBe(false);
  });

  it('refuses once the person it added was edited since, touching nothing', async () => {
    const v = setUp();
    const applied = appliedOf(await v.apply(LUNCH));
    const person = 'People/Tobias Fenn.md';
    v.files.set(person, `${v.files.get(person)!}Met at the renewal.\n`);
    const after = v.snapshot();
    const undone = await v.undo(applied);
    expect(undone).toMatchObject({
      kind: 'refused',
      words: expect.stringContaining('Tobias Fenn it was changed since'),
    });
    expect(v.files).toEqual(after);
  });

  it('refuses while the item has typing not saved', async () => {
    const v = setUp();
    const applied = appliedOf(await v.apply(CALL));
    v.vault.unsaved.add(applied.path);
    expect(await v.undo(applied)).toMatchObject({
      kind: 'refused',
      words: expect.stringContaining('typing'),
    });
  });

  it('undoes every row, the last applied first, each on its own', async () => {
    const v = setUp();
    const before = v.snapshot();
    const previewed = await v.preview();
    const results = await applySureRows(v.ports, {
      rows: previewed.rows,
      notePaths: v.notePaths(),
    });
    const undos = results.flatMap(({ path, applied }) =>
      applied.kind === 'applied' ? [{ path: createVaultPath(path), undo: applied.undo }] : [],
    );
    expect(undos).toHaveLength(4);
    const order: VaultPath[] = [];
    const undone = await undoAssistRows(v.ports, {
      undos,
      notePaths: v.notePaths(),
      onEach: ({ path }) => void order.push(path),
    });
    expect(undone.every(({ undone: each }) => each.kind === 'undone')).toBe(true);
    expect(order).toEqual([RENEW, LUNCH, ARTICLE, CALL]);
    expect(notesBut(v.files)).toEqual(notesBut(before));
  });
});

describe('undo: the edges', () => {
  it('refuses once the person it added is gone, touching nothing', async () => {
    const v = setUp();
    const applied = appliedOf(await v.apply(LUNCH));
    v.files.delete('People/Tobias Fenn.md');
    const after = v.snapshot();
    expect(await v.undo(applied)).toEqual({
      kind: 'refused',
      words: 'Not undone: Tobias Fenn is not where it was added.',
    });
    expect(v.files).toEqual(after);
  });

  it('puts the item back and keeps the person, saying so, when the Trash refuses them', async () => {
    const v = setUp();
    const applied = appliedOf(await v.apply(LUNCH));
    v.ports.fs.trashEntry = async () => {
      throw new Error('the Trash is not there');
    };
    const undone = await v.undo(applied);
    expect(undone).toMatchObject({
      kind: 'undone',
      words: 'Put back as it was. Tobias Fenn was kept: the Trash is not there',
    });
    expect(v.files.get(LUNCH)).toBe(VAULT[LUNCH]);
    expect(v.files.has('People/Tobias Fenn.md')).toBe(true);
    const [, undo] = parseRunLog(v.files.get(LOG)!);
    expect(undo).toMatchObject({ kind: 'undo', left: [{ path: 'People/Tobias Fenn.md' }] });
  });

  it('undoes the rest when one row of Undo all is refused', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const results = await applySureRows(v.ports, {
      rows: previewed.rows,
      notePaths: v.notePaths(),
    });
    const undos = results.flatMap(({ path, applied }) =>
      applied.kind === 'applied' ? [{ path: createVaultPath(path), undo: applied.undo }] : [],
    );
    const call = undos.find(({ path }) => path === CALL)!.undo.item.to;
    v.files.set(call, `${v.files.get(call)!}Mine.\n`);
    const undone = await undoAssistRows(v.ports, { undos, notePaths: v.notePaths() });
    expect(undone.map(({ path, undone: each }) => [path, each.kind])).toEqual([
      [RENEW, 'undone'],
      [LUNCH, 'undone'],
      [ARTICLE, 'undone'],
      [CALL, 'refused'],
    ]);
  });
});

describe('the preview, for Apply', () => {
  it('keeps no digest of a kept task it cannot read, so applying that row asks', async () => {
    const v = setUp();
    const read = v.ports.fs.readNotes;
    v.ports.fs.readNotes = async (paths) =>
      (await read(paths)).filter((note) => note.path !== KEPT);
    const previewed = await v.preview();
    expect(previewed.of(RENEW).evidence?.kept).toBeNull();
    v.ports.fs.readNotes = read;
    expect(await v.apply(RENEW, previewed)).toEqual({
      kind: 'failed',
      words: 'Not applied: The digest of the kept task at the preview is missing. Nothing changed.',
    });
  });

  it('applies nothing for a row it has no evidence for', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const results = await applySureRows(v.ports, {
      rows: previewed.rows.map(({ row }) => ({ row, evidence: undefined })),
      notePaths: v.notePaths(),
    });
    expect(results).toEqual([]);
    expect(
      await applyAssistRow(v.ports, {
        ...previewed.of(CALL),
        evidence: undefined,
        notePaths: v.notePaths(),
      }),
    ).toMatchObject({
      applied: {
        kind: 'failed',
        words: 'Not applied: Nothing of it was kept at the preview. Nothing changed.',
      },
    });
  });

  it('plans no change of an item whose frontmatter cannot be read', async () => {
    const v = setUp({ ...VAULT, [CALL]: `---\n{not json\n---\n${VAULT[CALL]!}` });
    const previewed = await v.preview();
    expect(previewed.of(CALL).row.step.kind).toBe('ask');
  });
});

/** Hands the first read of `path` back as it was, then puts `edited` in its place with the same file time, as a coarse disk would. */
function editAfterFirstRead(v: ReturnType<typeof setUp>, path: string, edited: string) {
  const read = v.ports.fs.readTextFile;
  let first = true;
  v.ports.fs.readTextFile = async (at) => {
    const answer = await read(at);
    if (at === path && first) {
      first = false;
      v.files.set(path, edited);
    }
    return answer;
  };
}

describe('review #911: every write is held to the text that was checked', () => {
  it('stamps no duplicate whose text changed within the same file time after the check (item 2)', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const edited = 'Ask them about the price first.\n';
    editAfterFirstRead(v, RENEW, edited);
    const applied = await v.apply(RENEW, previewed);
    expect(applied.kind).toBe('failed');
    expect(v.files.get(RENEW)).toBe(edited);
    expect(v.vault.log.filter((line) => !line.includes(LOG))).toEqual([]);
  });

  it('writes no field over a due date set after the check, before Clarify reads (item 3)', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const edited = json({ due: '2026-12-05' }, VAULT[CALL]);
    editAfterFirstRead(v, CALL, edited);
    const applied = await v.apply(CALL, previewed);
    expect(applied.kind).toBe('failed');
    expect(v.files.get(CALL)).toBe(edited);
    expect(v.vault.log.filter((line) => !line.includes(LOG))).toEqual([]);
  });
});

describe('review #911: a row that does not belong with its evidence is refused before anything is read (item 4)', () => {
  const refusedUnread = async (
    bend: (given: { row: AssistRow; evidence: AssistEvidence }) => {
      row: AssistRow;
      evidence: AssistEvidence;
    },
  ) => {
    const v = setUp();
    const previewed = await v.preview();
    const given = bend({ row: previewed.of(CALL).row, evidence: previewed.of(CALL).evidence! });
    let reads = 0;
    const read = v.ports.fs.readTextFile;
    v.ports.fs.readTextFile = async (at) => {
      reads += 1;
      return read(at);
    };
    const before = v.snapshot();
    const { applied } = await applyAssistRow(v.ports, { ...given, notePaths: v.notePaths() });
    expect(applied).toMatchObject({
      kind: 'failed',
      words: expect.stringMatching(/^Not applied: .*Nothing changed\.$/u),
    });
    expect(reads).toBe(0);
    expect(v.files).toEqual(before);
    return applied;
  };

  it('refuses evidence of another item', async () => {
    const v = setUp();
    const other = (await v.preview()).of(LUNCH).evidence!;
    await refusedUnread(({ row }) => ({ row, evidence: other }));
  });

  it('refuses a missing digest', async () => {
    await refusedUnread(({ row, evidence }) => ({ row, evidence: { ...evidence, digest: '' } }));
  });

  it('refuses a path that is not the vault’s own', async () => {
    await refusedUnread(({ row, evidence }) => {
      const path = 'Inbox/../People/Mara Quill.md' as VaultPath;
      return {
        row: { ...row, path },
        evidence: {
          ...evidence,
          item: { ...evidence.item, path },
          answer: { ...evidence.answer, item: path },
        },
      };
    });
  });

  it('refuses a duplicate whose copy is not an Inbox item', async () => {
    const v = setUp();
    const renew = (await v.preview()).of(RENEW);
    await refusedUnread(() => {
      const path = createVaultPath('Tasks/Renew Larkspur contract copy.md');
      const evidence = renew.evidence!;
      return {
        row: { ...renew.row, path },
        evidence: {
          ...evidence,
          item: { ...evidence.item, path },
          answer: { ...evidence.answer, item: path },
        },
      };
    });
  });

  it('refuses a question', async () => {
    const v = setUp();
    const junk = (await v.preview()).of(JUNK);
    await refusedUnread(() => ({ row: junk.row, evidence: junk.evidence! }));
  });
});

describe('review #911: a row leaves a trace before it writes (item 5)', () => {
  it('logs that it began before the first write, each person made at once, and that it ended', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const seen: string[] = [];
    const logAt = () =>
      parseAssistLog(v.files.get(LOG) ?? '')
        .map((entry) => entry.kind)
        .join(',');
    for (const method of ['writeTextFile', 'createNote', 'moveEntry'] as const) {
      const was = v.ports.fs[method] as (args: {
        path?: string;
        from?: string;
      }) => Promise<unknown>;
      (v.ports.fs as unknown as Record<string, unknown>)[method] = async (args: {
        path?: string;
        from?: string;
      }) => {
        if ((args.path ?? args.from) !== LOG)
          seen.push(`${method} ${args.path ?? args.from} after [${logAt()}]`);
        return was(args);
      };
    }
    appliedOf(await v.apply(LUNCH, previewed));
    expect(seen).toEqual([
      `writeTextFile ${LUNCH} after [begun]`,
      'createNote People/Tobias Fenn.md after [begun]',
      `writeTextFile ${LUNCH} after [begun,step]`,
    ]);
    expect(parseAssistLog(v.files.get(LOG)!).map((entry) => entry.kind)).toEqual([
      'begun',
      'step',
      'run',
    ]);
  });

  it('closes the row it began when it is taken back', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.fail({ method: 'moveEntry', nth: 1 });
    expect((await v.apply(CALL, previewed)).kind).toBe('failed');
    expect(parseAssistLog(v.files.get(LOG)!).map((entry) => entry.kind)).toEqual([
      'begun',
      'failed',
    ]);
    expect(await findUnfinishedAssist(v.ports)).toEqual([]);
  });

  it('finds a row a crash left unfinished, and says what is on disk and how to put it right', async () => {
    const v = setUp();
    const at = CLOCK.localNow();
    const row = `${at} ${LUNCH}`;
    const person = json({ type: 'person', email: 'tobias@example.org' });
    v.files.set('People/Tobias Fenn.md', person);
    for (const entry of [
      {
        kind: 'begun' as const,
        at,
        row,
        path: createVaultPath(LUNCH),
        digest: digestOf(VAULT[LUNCH]!),
        plan: 'Made it a task. Added Tobias Fenn.',
      },
      {
        kind: 'step' as const,
        at,
        row,
        done: [
          {
            kind: 'created' as const,
            path: createVaultPath('People/Tobias Fenn.md'),
            digest: digestOf(person),
          },
        ],
      },
    ]) {
      await appendToRuleLog({ fs: v.ports.fs, rule: INBOX_ASSIST_RULE, entry, now: CLOCK.now() });
    }
    const before = v.snapshot();
    expect(await findUnfinishedAssist(v.ports)).toEqual([
      {
        title: 'Lunch with Tobias',
        path: LUNCH,
        lines: [
          'It was to do: Made it a task. Added Tobias Fenn.',
          'Lunch with Tobias is where it was, as it was before.',
          'Tobias Fenn was made (People/Tobias Fenn.md), as made. Link it from Lunch with Tobias, or put it in the Trash.',
        ],
      },
    ]);
    // Said, never repaired.
    expect(v.files).toEqual(before);
  });
});

describe('apply then undo, as a seeded property', () => {
  /** A note's links, as a person writes them: by title, by path, and by path under an alias. */
  const linksTo = (path: string, random: () => number) => {
    const title = path.split('/').pop()!.slice(0, -3);
    const forms = [
      `[[${title}]]`,
      `[[${path.slice(0, -3)}]]`,
      `[[${path.slice(0, -3)}|${title.toLowerCase()}]]`,
    ];
    return forms.filter(() => random() < 0.6);
  };
  /** Third notes linking the items, the kept task and a note sharing an item's title. */
  function thirdNotes(random: () => number): Record<string, string> {
    const targets = [CALL, ARTICLE, LUNCH, RENEW, KEPT, 'Reference/Payroll article.md'];
    const notes: Record<string, string> = {
      'Reference/Payroll article.md': 'Clipped from the web.\n',
    };
    for (const [at, name] of [
      'Notes/Week.md',
      'Notes/Ideas.md',
      'Projects/Larkspur log.md',
    ].entries()) {
      const links = targets.flatMap((target) => linksTo(target, random));
      notes[name] = `${at % 2 === 0 ? '' : '---\ntags: [log]\n---\n'}See ${links.join(', ')}.\n`;
    }
    return notes;
  }

  it('restores every byte of every note, and every path, whatever rows are applied and in whatever order', async () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const random = seededRandom(seed);
      const v = setUp({ ...VAULT, ...thirdNotes(random) });
      const before = v.snapshot();
      const previewed = await v.preview();
      const rows = [...previewed.rows].sort(() => random() - 0.5).filter(() => random() < 0.8);
      const results = await applySureRows(v.ports, { rows, notePaths: v.notePaths() });
      expect(v.files.get(KEPT), `seed ${seed}`).toBe(VAULT[KEPT]);
      for (const path of v.files.keys())
        expect(path.includes('..'), `seed ${seed}: ${path}`).toBe(false);
      const undos = results.flatMap(({ path, applied }) =>
        applied.kind === 'applied' ? [{ path: createVaultPath(path), undo: applied.undo }] : [],
      );
      const undone = await undoAssistRows(v.ports, { undos, notePaths: v.notePaths() });
      expect(
        undone.map(({ undone: each }) => each.kind),
        `seed ${seed}`,
      ).not.toContain('refused');
      expect([...notesBut(v.files).keys()].sort(), `seed ${seed}`).toEqual(
        [...notesBut(before).keys()].sort(),
      );
      expect(notesBut(v.files), `seed ${seed}`).toEqual(notesBut(before));
    }
  });
});
