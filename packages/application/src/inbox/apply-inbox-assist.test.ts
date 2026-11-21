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
  isInInbox,
  type AssistEvidence,
  type AssistIntent,
  type AssistRow,
  type InboxItem,
  type VaultPath,
  EVERY_ASSIST_KIND,
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
import { VAULT_FS_METHODS } from './assist-guard.ts';
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
    return (
      await applyAssistRow(ports, {
        appliable: EVERY_ASSIST_KIND,
        row,
        evidence,
        notePaths: notePaths(),
      })
    ).applied;
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
      words: expect.stringContaining('It could not be taken back'),
      // Held, to be finished: the same path as an undo that stopped.
      undo: { row: expect.any(String) },
    });
    // The row stays open, its last step saying what is on disk: it is shown as left unfinished.
    const entries = parseAssistLog(v.files.get(LOG)!);
    expect(entries.at(-1)).toMatchObject({
      kind: 'step',
      done: [expect.objectContaining({ kind: 'assisted' })],
    });
    expect(parseRunLog(v.files.get(LOG)!)).toEqual([]);
    expect(await findUnfinishedAssist(v.ports)).toHaveLength(1);
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
      // Only the entry closing the row, its heading "Ran by hand", cannot be written.
      if (each.path === LOG && each.contents.includes('· Ran by hand'))
        throw new Error('the disk is full');
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

describe('review #911 round 4: the rows that move a note are shown, not applied, for now (#925)', () => {
  it('applies an Inbox task where it is, and refuses filing and a duplicate, writing nothing', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const before = v.snapshot();
    for (const [path, why] of [
      [CALL, 'Filing is not applied automatically yet.'],
      [ARTICLE, 'Filing is not applied automatically yet.'],
      [RENEW, 'Archiving a duplicate is not applied automatically yet.'],
    ] as const) {
      const { row, evidence } = previewed.of(path);
      const { applied } = await applyAssistRow(v.ports, {
        row,
        evidence,
        notePaths: v.notePaths(),
      });
      expect(applied, path).toEqual({
        kind: 'failed',
        words: `Not applied: ${why} Nothing changed.`,
      });
    }
    expect(v.snapshot()).toEqual(before);
    const { row, evidence } = previewed.of(LUNCH);
    expect(
      (await applyAssistRow(v.ports, { row, evidence, notePaths: v.notePaths() })).applied,
    ).toMatchObject({
      kind: 'applied',
      path: LUNCH,
    });
  });

  it('Apply all sure ones skips the rows that move a note', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const results = await applySureRows(v.ports, {
      rows: previewed.rows,
      notePaths: v.notePaths(),
    });
    expect(results.map(({ path, applied }) => [path, applied.kind])).toEqual([[LUNCH, 'applied']]);
  });
});

describe('applySureRows', () => {
  it('applies each sure row on its own, skips questions, and goes on past one that asks', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.files.set(ARTICLE, `${VAULT[ARTICLE]!}Edited.\r\n`);
    const seen: string[] = [];
    const results = await applySureRows(v.ports, {
      appliable: EVERY_ASSIST_KIND,
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
      appliable: EVERY_ASSIST_KIND,
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
      appliable: EVERY_ASSIST_KIND,
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
      words: 'Not undone: It was changed since, so it was left as it is.',
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
      appliable: EVERY_ASSIST_KIND,
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
      appliable: EVERY_ASSIST_KIND,
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
      appliable: EVERY_ASSIST_KIND,
      rows: previewed.rows.map(({ row }) => ({ row, evidence: undefined })),
      notePaths: v.notePaths(),
    });
    expect(results).toEqual([]);
    expect(
      await applyAssistRow(v.ports, {
        appliable: EVERY_ASSIST_KIND,
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
    const { applied } = await applyAssistRow(v.ports, {
      appliable: EVERY_ASSIST_KIND,
      ...given,
      notePaths: v.notePaths(),
    });
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
      // Every write logged as about to be made, just before it is; his making logged right after.
      `writeTextFile ${LUNCH} after [begun,step]`,
      'createNote People/Tobias Fenn.md after [begun,step,step]',
      `writeTextFile ${LUNCH} after [begun,step,step,step,step]`,
    ]);
    // Begun, a step before each write and after the person made, then closed.
    const kinds = parseAssistLog(v.files.get(LOG)!).map((entry) => entry.kind);
    expect([kinds[0], kinds.at(-1), new Set(kinds.slice(1, -1))]).toEqual([
      'begun',
      'run',
      new Set(['step']),
    ]);
  });

  it('closes the row it began when it is taken back', async () => {
    const v = setUp();
    const previewed = await v.preview();
    v.fail({ method: 'moveEntry', nth: 1 });
    expect((await v.apply(CALL, previewed)).kind).toBe('failed');
    // Begun, a step before each write (the move that failed and the rollback's), then closed.
    const kinds = parseAssistLog(v.files.get(LOG)!).map((entry) => entry.kind);
    expect([kinds[0], kinds.at(-1), new Set(kinds.slice(1, -1))]).toEqual([
      'begun',
      'failed',
      new Set(['step']),
    ]);
    expect(await findUnfinishedAssist(v.ports)).toEqual([]);
  });

  it('says what is on disk of each note a crash was writing, by its digests (round 4, 6)', async () => {
    const v = setUp();
    const at = CLOCK.localNow();
    const row = `${at} ${CALL} 1.1`;
    const week = createVaultPath('Notes/Week.md');
    const month = createVaultPath('Notes/Month.md');
    const year = createVaultPath('Notes/Year.md');
    const made = createVaultPath('People/Rook Ashby.md');
    const was = 'See [[Inbox/Call Mara]].\n';
    const rewritten = 'See [[Tasks/Call Mara]].\n';
    for (const [path, text] of [
      [week, rewritten],
      [month, was],
      [year, 'Mine now.\n'],
      [made, 'Made.\n'],
    ] as const) {
      v.files.set(path, text);
    }
    const about = (intent: AssistIntent) => ({
      kind: 'step' as const,
      at,
      row,
      done: [],
      about: intent,
    });
    for (const entry of [
      {
        kind: 'begun' as const,
        at,
        row,
        path: createVaultPath(CALL),
        digest: digestOf(VAULT[CALL]!),
        plan: 'Made it a task.',
      },
      about({ doing: 'relink', path: week, holding: digestOf(was), leaving: digestOf(rewritten) }),
      about({ doing: 'relink', path: month, holding: digestOf(was), leaving: digestOf(rewritten) }),
      about({ doing: 'relink', path: year, holding: digestOf(was), leaving: digestOf(rewritten) }),
      about({ doing: 'create', path: made, leaving: digestOf('Made.\n') }),
    ]) {
      await appendToRuleLog({ fs: v.ports.fs, rule: INBOX_ASSIST_RULE, entry, now: CLOCK.now() });
    }
    const [left] = await findUnfinishedAssist(v.ports);
    expect(left!.lines.slice(2)).toEqual([
      `Week (${week}) was changed: its links to Call Mara were rewritten. Check them.`,
      `Month (${month}) was not changed.`,
      `Year (${year}) has changed since: what the row wrote may not be in it. Check it.`,
      `Rook Ashby was made (${made}) just before it stopped, and is as made. Link it from Call Mara, or put it in the Trash.`,
    ]);
  });

  it('says when what a crash left was changed or is gone since', async () => {
    const v = setUp();
    const at = CLOCK.localNow();
    const person = json({ type: 'person', email: 'tobias@example.org' });
    for (const entry of [
      {
        kind: 'begun' as const,
        at,
        row: `${at} ${LUNCH}`,
        path: createVaultPath(LUNCH),
        digest: digestOf(VAULT[LUNCH]!),
        plan: 'Added Tobias Fenn.',
      },
      {
        kind: 'step' as const,
        at,
        row: `${at} ${LUNCH}`,
        done: [
          {
            kind: 'created' as const,
            path: createVaultPath('People/Tobias Fenn.md'),
            digest: digestOf(person),
          },
        ],
      },
      {
        kind: 'begun' as const,
        at,
        row: `${at} ${CALL}`,
        path: createVaultPath(CALL),
        digest: digestOf(VAULT[CALL]!),
        plan: 'Made it a task.',
      },
      {
        kind: 'step' as const,
        at,
        row: `${at} ${CALL}`,
        done: [
          {
            kind: 'created' as const,
            path: createVaultPath('People/Gone.md'),
            digest: digestOf('x'),
          },
        ],
      },
    ]) {
      await appendToRuleLog({ fs: v.ports.fs, rule: INBOX_ASSIST_RULE, entry, now: CLOCK.now() });
    }
    v.files.set(LUNCH, `${VAULT[LUNCH]!}Edited.\n`);
    v.files.set('People/Tobias Fenn.md', `${person}Edited.\n`);
    v.files.delete(CALL);
    const found = await findUnfinishedAssist(v.ports);
    expect(found.map(({ lines }) => lines.slice(1))).toEqual([
      [
        'Lunch with Tobias is where it was, but says something else: what the row wrote may be in it. Check its properties.',
        'Tobias Fenn was made (People/Tobias Fenn.md) and changed since. Keep it, or put it in the Trash.',
      ],
      [
        `Call Mara is no longer at ${CALL}: it may have been filed or archived. Look for it there.`,
        'Gone was made (People/Gone.md) and is gone since.',
      ],
    ]);
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
        row,
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

/** Appends `edit` to the note right after the row moves it: another editor saving into it as it lands. */
function editAfterTheMove(v: ReturnType<typeof setUp>, edit: string) {
  const move = v.ports.fs.moveEntry;
  const edited = { count: 0 };
  v.ports.fs.moveEntry = async (each) => {
    await move(each);
    // Only as a row moves a note on, out of the Inbox: never as an undo moves it back.
    if (each.to === LOG || isInInbox(each.to) || v.files.get(each.to)?.endsWith(edit) !== false) {
      return;
    }
    v.files.set(each.to, `${v.files.get(each.to)!}${edit}`);
    edited.count += 1;
  };
  return edited;
}

describe('review #911 round 2: an edit made while the row moves the note is never lost (item 1)', () => {
  for (const [row, kind] of [
    [ARTICLE, 'filing'],
    [RENEW, 'duplicate'],
  ] as const) {
    it(`${kind}: the stamp where it lands is refused, and the note goes back with the edit`, async () => {
      const v = setUp();
      const previewed = await v.preview();
      editAfterTheMove(v, 'Mine.\n');
      const applied = await v.apply(row, previewed);
      expect(applied).toMatchObject({
        kind: 'failed',
        words: expect.stringContaining('back where it was with that edit kept'),
      });
      // Back where it was, its edit in it: never stamped over, never written back over.
      expect(v.files.get(row)).toMatch(/Mine\.\n$/u);
      expect(
        [...v.files.keys()].filter(
          (path) => path.startsWith('Archive/') || path.startsWith('Notes/2026'),
        ),
      ).toEqual([]);
      const closing = parseRunLog(v.files.get(LOG)!).at(-1)!;
      expect(closing).toMatchObject({
        kind: 'failed',
        done: [{ kind: 'assisted', from: row, to: row }],
      });
    });
  }
});

describe('review #911 round 2: an undo that stops part-way says so, logs it, and can finish (item 2)', () => {
  it('undoAssistRow: the move back refused after the text is put back', async () => {
    const v = setUp();
    const before = v.snapshot();
    const applied = appliedOf(await v.apply(CALL));
    const move = v.ports.fs.moveEntry;
    v.ports.fs.moveEntry = async () => {
      throw new Error('the disk refused the move');
    };
    const partly = await v.undo(applied);
    expect(partly).toMatchObject({
      kind: 'partly',
      words: `Partly undone: Call Mara is still at ${applied.path}. Undo again to finish.`,
      undo: { progress: { itemRestored: true } },
    });
    // The row stays open — shown as left unfinished after a restart — what was done logged.
    expect(parseAssistLog(v.files.get(LOG)!).at(-1)).toMatchObject({ kind: 'step' });
    expect(await findUnfinishedAssist(v.ports)).toHaveLength(1);
    expect(v.activity.reports.at(-1)).toMatchObject({
      level: 'warning',
      message: expect.stringContaining('could not undo'),
    });
    v.ports.fs.moveEntry = move;
    if (partly.kind !== 'partly') throw new Error('not partly undone');
    const undone = await undoAssistRow(v.ports, { undo: partly.undo, notePaths: v.notePaths() });
    expect(undone).toMatchObject({ kind: 'undone' });
    expect(parseAssistLog(v.files.get(LOG)!).at(-1)).toMatchObject({
      kind: 'undo',
      row: applied.undo.row,
    });
    expect(await findUnfinishedAssist(v.ports)).toEqual([]);
    expect(notesBut(v.files)).toEqual(notesBut(before));
  });

  it('takeBack: a failed row whose move back is refused says where the item is, and logs it there', async () => {
    const v = setUp();
    const previewed = await v.preview();
    // The people link fails, then the move back does too.
    v.fail({ method: 'writeTextFile', nth: 3 });
    const move = v.ports.fs.moveEntry;
    let moves = 0;
    v.ports.fs.moveEntry = async (each) => {
      moves += 1;
      if (moves > 1) throw new Error('the disk refused the move');
      return move(each);
    };
    const applied = await v.apply(CALL, previewed);
    expect(applied).toMatchObject({
      kind: 'failed',
      words: expect.stringContaining('Taking it back stopped part-way'),
      undo: { progress: { itemRestored: true } },
    });
    // Not closed: the row stays open with what is on disk, where the item still is.
    const last = parseAssistLog(v.files.get(LOG)!).at(-1)!;
    expect(last).toMatchObject({ kind: 'step' });
    const where =
      last.kind === 'step' ? last.done.find((each) => each.kind === 'assisted') : undefined;
    const left = where?.kind === 'assisted' ? where.to : CALL;
    expect(left).not.toBe(CALL);
    expect(v.files.get(left)).toBe(VAULT[CALL]);
    expect(await findUnfinishedAssist(v.ports)).toHaveLength(1);
    // And it can be finished, as any undo that stopped.
    v.ports.fs.moveEntry = move;
    if (applied.kind !== 'failed' || applied.undo === undefined) throw new Error('no undo held');
    expect(
      await undoAssistRow(v.ports, { undo: applied.undo, notePaths: v.notePaths() }),
    ).toMatchObject({ kind: 'undone' });
    expect(v.files.get(CALL)).toBe(VAULT[CALL]);
  });
});

describe('review #911 round 2: undo never breaks a link made since (item 4)', () => {
  it('refuses, naming the note, when another note now links to it where it was filed', async () => {
    const v = setUp();
    const applied = appliedOf(await v.apply(CALL));
    v.files.set('Notes/Week.md', `See [[${applied.path.slice(0, -3)}|the call]].\n`);
    const after = v.snapshot();
    expect(await v.undo(applied)).toEqual({
      kind: 'refused',
      words:
        'Not undone: Week links to it where it is now, and undoing would break that link, so nothing was undone.',
    });
    expect(v.files).toEqual(after);
  });
});

describe('review #911 round 2: a path as the vault spells it (item 7)', () => {
  it('refuses an item whose path is spelled otherwise than the vault spells it, before reading anything', async () => {
    const v = setUp();
    const { row, evidence } = (await v.preview()).of(CALL);
    const bent = 'inbox/Call Mara.md' as VaultPath;
    let reads = 0;
    const read = v.ports.fs.readTextFile;
    v.ports.fs.readTextFile = async (at) => {
      reads += 1;
      return read(at);
    };
    const { applied } = await applyAssistRow(v.ports, {
      appliable: EVERY_ASSIST_KIND,
      row: { ...row, path: bent },
      evidence: {
        ...evidence!,
        item: { ...evidence!.item, path: bent },
        answer: { ...evidence!.answer, item: bent },
      },
      notePaths: v.notePaths(),
    });
    expect(applied).toEqual({
      kind: 'failed',
      words: `Not applied: the vault spells it ${CALL}. Nothing changed.`,
    });
    expect(reads).toBe(0);
  });
});

/** The vault with a third note linking every item by path and an item linking itself: every write a filing makes. */
const LINKED: Record<string, string> = {
  ...VAULT,
  [ARTICLE]: `${VAULT[ARTICLE]!}See [[Inbox/Payroll article]].\r\n`,
  'Notes/Week.md':
    'See [[Inbox/Call Mara]], [[Inbox/Payroll article|the article]], [[Inbox/Lunch with Tobias]] and [[Inbox/Renew Larkspur contract]].\n',
};
const ROW_KINDS = [CALL, ARTICLE, LUNCH, RENEW] as const;
/** Every method of the vault port that is not a read, from the guard's own placing of each (#911, round 4). */
const WRITES = Object.entries(VAULT_FS_METHODS).flatMap(([method, kind]) =>
  kind === 'read' ? [] : [method],
);
/** Every method of the vault port, watched: a read changes nothing, but tells where the row is. */
const EVERY_METHOD = Object.keys(VAULT_FS_METHODS);
/** The log and the folders it lives in: written beside the guard, never a note. */
const ofTheLog = (path: string) => path === '.atlas' || path.startsWith('.atlas/');

/** Every host call, in order, with what the log said as it was made. */
function watched(v: ReturnType<typeof setUp>) {
  const calls: { method: string; args: Record<string, unknown>; log: string }[] = [];
  const fs = v.ports.fs as unknown as Record<string, (args: unknown) => Promise<unknown>>;
  for (const method of EVERY_METHOD) {
    const inner = fs[method]!;
    fs[method] = async (args: unknown) => {
      const named = typeof args === 'string' ? { path: args } : (args as Record<string, unknown>);
      calls.push({ method, args: named, log: v.files.get(LOG) ?? '' });
      return inner(args);
    };
  }
  return calls;
}

/** Each write to a note that escaped the guard: not logged first, not held to its text. Empty when none did. */
function escapes(calls: ReturnType<typeof watched>): string[] {
  const found: string[] = [];
  calls.forEach(({ method, args, log }, at) => {
    if (!WRITES.includes(method)) return;
    const path = String(args['path'] ?? args['from']);
    if (ofTheLog(path)) return;
    const last = parseAssistLog(log).at(-1);
    const about = last?.kind === 'step' ? last.about : undefined;
    if (about === undefined || about.path !== path)
      found.push(`${method} ${path}: not logged first`);
    if (method === 'writeTextFile' && typeof args['expectedText'] !== 'string')
      found.push(`${method} ${path}: not held to its text`);
    if (method === 'trashEntry' && !Array.isArray(args['unchanged']))
      found.push(`${method} ${path}: not held to its text`);
    if (method === 'moveEntry') {
      const before = calls
        .slice(0, at)
        .filter((each) => !ofTheLog(String(each.args['path'] ?? each.args['from'] ?? '')))
        .at(-1);
      if (before?.method !== 'readTextFile' || before.args['path'] !== path)
        found.push(`${method} ${path}: source not read just before`);
    }
    if (method === 'writeBinaryFile') found.push(`${method} ${path}: never written by a row`);
  });
  return found;
}

/** Fails the `nth` write to a note (the log's own aside), whatever kind it is. */
function failingWrite(v: ReturnType<typeof setUp>, nth: number) {
  const fs = v.ports.fs as unknown as Record<string, (args: unknown) => Promise<unknown>>;
  let count = 0;
  for (const method of WRITES) {
    const inner = fs[method]!;
    fs[method] = async (args: unknown) => {
      const named = args as Record<string, unknown>;
      if (!ofTheLog(String(named['path'] ?? named['from']))) {
        count += 1;
        if (count === nth) throw new Error(`the disk refused write ${nth}`);
      }
      return inner(args);
    };
  }
}

describe('review #911 round 3: a rollback that keeps an edit takes out whom it made (7)', () => {
  it('puts Tobias in the Trash and says so, the item back with the person’s edit', async () => {
    const v = setUp();
    const previewed = await v.preview();
    const create = v.ports.fs.createNote;
    // The person types into the item just after Tobias is made: the row's link to him is refused.
    v.ports.fs.createNote = async (each) => {
      const made = await create(each);
      if (each.path.startsWith('People/')) v.files.set(LUNCH, `${v.files.get(LUNCH)!}Mine.\n`);
      return made;
    };
    const applied = await v.apply(LUNCH, previewed);
    expect(applied).toMatchObject({
      kind: 'failed',
      words: expect.stringContaining('Tobias Fenn was added, then taken out again (in the Trash).'),
    });
    // Kept as the person left it, what the row wrote before their edit included: never written over.
    expect(v.files.get(LUNCH)).toMatch(/Mine\.\n$/u);
    expect(applied.kind === 'failed' && applied.words).toContain('edit kept');
    expect(v.files.has('People/Tobias Fenn.md')).toBe(false);
    expect(await findUnfinishedAssist(v.ports)).toEqual([]);
  });
});

describe('review #911 round 3: no write of a row escapes the one guarded path (A)', () => {
  it.each(ROW_KINDS)(
    '%s: in its apply, its rollback after a failure at every position, and its undo',
    async (row) => {
      let checked = 0;
      {
        // A clean apply and its undo, and how many writes the apply makes.
        const clean = setUp(LINKED);
        const previewed = await clean.preview();
        const calls = watched(clean);
        const applied = appliedOf(await clean.apply(row, previewed));
        expect(await clean.undo(applied)).toMatchObject({ kind: 'undone' });
        expect(escapes(calls).join(' | '), row).toBe('');
        const writes = calls.filter(
          ({ method, args }) =>
            WRITES.includes(method) && !ofTheLog(String(args['path'] ?? args['from'])),
        );
        checked += writes.length;
        // Each write of the apply failing in turn: the rollback's writes too go through the guard.
        // Past the apply's own writes, the apply simply succeeds: harmless, and counted too.
        for (let nth = 1; nth <= writes.length; nth += 1) {
          const v = setUp(LINKED);
          const again = await v.preview();
          const seen = watched(v);
          failingWrite(v, nth);
          const outcome = await v.apply(row, again);
          if (outcome.kind === 'failed' && outcome.undo !== undefined) {
            await undoAssistRow(v.ports, { undo: outcome.undo, notePaths: v.notePaths() });
          }
          expect(escapes(seen), `${row}, write ${nth} failing`).toEqual([]);
          checked += seen.filter(({ method }) => WRITES.includes(method)).length;
        }
      }
      // The test is about something: it looked at every write of the row, and of each rollback.
      expect(checked).toBeGreaterThan(10);
    },
  );

  it('would catch a write made around the guard', async () => {
    const v = setUp(LINKED);
    const previewed = await v.preview();
    const calls = watched(v);
    appliedOf(await v.apply(CALL, previewed));
    // A write a use-case made straight to the port, not logged first nor held: caught.
    await v.ports.fs.writeTextFile({
      path: createVaultPath('Notes/Week.md'),
      contents: 'x\n',
      expectedModified: null,
    });
    expect(escapes(calls)).toEqual([
      'writeTextFile Notes/Week.md: not logged first',
      'writeTextFile Notes/Week.md: not held to its text',
    ]);
  });
});

/**
 * Applies or undoes `row` once for each host call it makes, a person's edit
 * landing on the item or a note linking it just after that call, and checks
 * the bytes; resolves to how many calls it tried.
 */
async function sweepEdits(
  row: (typeof ROW_KINDS)[number],
  target: 'item' | 'Notes/Week.md',
  phase: 'apply' | 'undo',
): Promise<number> {
  // What a clean apply of the row leaves each note saying: an applied row whose undo was refused stays so.
  const clean = setUp(LINKED);
  appliedOf(await clean.apply(row, await clean.preview()));
  const appliedState = clean.snapshot();
  for (let k = 1; ; k += 1) {
    const v = setUp(LINKED);
    const before = v.snapshot();
    const previewed = await v.preview();
    const applied = phase === 'undo' ? appliedOf(await v.apply(row, previewed)) : null;
    const edited = editAfterCall(v, { k, target, itemAt: applied?.path ?? row });
    if (phase === 'apply') {
      const outcome = await v.apply(row, previewed);
      if (outcome.kind === 'applied') await v.undo(outcome).catch(() => undefined);
    } else {
      await v.undo(applied!);
    }
    if (edited.made === null) return k - 1;
    const { path, text } = edited.made;
    const where = `${row}, ${target}, ${phase}, after call ${k}`;
    // The person's edit is exactly as they left it: never written over, never undone away.
    expect(v.files.get(path) ?? [...v.files.values()].find((each) => each === text), where).toBe(
      text,
    );
    // Every note no one edited is exactly as it was before the row, or exactly as a clean apply leaves it.
    for (const [note, bytes] of notesBut(v.files)) {
      if (note === path || bytes === text || !before.has(note)) continue;
      const fine = before.get(note) === bytes || appliedState.get(note) === bytes;
      expect(fine, `${where}: ${note}`).toBe(true);
    }
  }
}

/** Makes the person's edit once, just after the `k`th host call to a note, following the item as it moves. */
function editAfterCall(
  v: ReturnType<typeof setUp>,
  { k, target, itemAt: start }: { k: number; target: 'item' | 'Notes/Week.md'; itemAt: string },
) {
  let itemAt = start;
  let calls = 0;
  const edited: { made: { path: string; text: string } | null } = { made: null };
  const fs = v.ports.fs as unknown as Record<string, (args: unknown) => Promise<unknown>>;
  for (const method of EVERY_METHOD) {
    const inner = fs[method]!;
    fs[method] = async (args: unknown) => {
      const answer = await inner(args);
      const named = typeof args === 'string' ? { path: args } : (args as Record<string, unknown>);
      if (method === 'moveEntry' && named['from'] === itemAt) itemAt = String(named['to']);
      const path = String(named['path'] ?? named['from'] ?? (Array.isArray(args) ? args[0] : ''));
      if (ofTheLog(path)) return answer;
      calls += 1;
      if (calls === k && edited.made === null) {
        const at = target === 'item' ? itemAt : target;
        const text = `${v.files.get(at)!}Mine.\n`;
        v.files.set(at, text);
        edited.made = { path: at, text };
      }
      return answer;
    };
  }
  return edited;
}

describe('review #911 round 3: a person’s edit, at any moment of a row, is never lost (11)', () => {
  const cases = ROW_KINDS.flatMap((row) =>
    (['item', 'Notes/Week.md'] as const).flatMap((target) =>
      (['apply', 'undo'] as const).map((phase) => [row, target, phase] as const),
    ),
  );
  it.each(cases)('%s, an edit on %s, during %s: exact bytes', async (row, target, phase) => {
    // About something: the row makes several host calls, and each was tried.
    expect(await sweepEdits(row, target, phase)).toBeGreaterThan(3);
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

  const SEEDS = Array.from({ length: 24 }, (_, at) => at + 1);
  it.each(SEEDS)(
    'seed %i: every byte of every note, and every path, back whatever rows are applied and in whatever order',
    async (seed) => {
      {
        const random = seededRandom(seed);
        const v = setUp({ ...VAULT, ...thirdNotes(random) });
        const before = v.snapshot();
        const previewed = await v.preview();
        // Every other seed, someone edits each note the row moves, as it lands (#911).
        const edits = seed % 2 === 0 ? editAfterTheMove(v, 'Mine.\n') : { count: 0 };
        const rows = [...previewed.rows].sort(() => random() - 0.5).filter(() => random() < 0.8);
        const results = await applySureRows(v.ports, {
          appliable: EVERY_ASSIST_KIND,
          rows,
          notePaths: v.notePaths(),
        });
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
        // Every edit is still there; every note no one edited is byte for byte as it was.
        const kept = [...notesBut(v.files)].filter(([, text]) => text.endsWith('Mine.\n'));
        expect(kept.length, `seed ${seed}`).toBe(edits.count);
        // About something: on an even seed, edits did land as notes moved.
        if (seed % 2 === 0) expect(edits.count, `seed ${seed}`).toBeGreaterThan(0);
        for (const [path] of kept) expect(before.get(path), `seed ${seed}: ${path}`).toBeDefined();
        const untouched = new Map(
          [...notesBut(v.files)].filter(([, text]) => !text.endsWith('Mine.\n')),
        );
        const touched = new Set(kept.map(([path]) => path));
        expect(untouched, `seed ${seed}`).toEqual(
          new Map([...notesBut(before)].filter(([path]) => !touched.has(path))),
        );
      }
    },
  );
});
