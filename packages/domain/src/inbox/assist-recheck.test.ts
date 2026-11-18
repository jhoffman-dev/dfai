import { describe, expect, it } from 'vitest';
import { assistRecheck, type AssistRecheck } from './assist-recheck.ts';
import {
  KEPT_PATH,
  KEPT_TASK,
  KEPT_TEXT,
  LARKSPUR,
  MARA,
  MARA_CANDIDATE,
  NOW,
  VAULT,
  noteNow,
  preview,
  recheckOf,
} from './assist-recheck.test-support.ts';

/**
 * #909: a planned row is applied only when the domain, with no model, finds
 * for that one item what the plan shown rests on: the item's own words and
 * the vault as they are now. One test per reason it asks instead.
 */

const asked = (checked: AssistRecheck) => (checked.kind === 'ask' ? checked.ask : 'apply');

/** A task to make, under Larkspur Payroll, due on a day its text says, linking Mara Quill by her address. */
const task = () =>
  preview({
    title: 'Call Mara',
    text: 'Call Mara Quill <mara.quill@example.com> about the renewal by 2026-12-01.\n',
    answer: {
      projects: [LARKSPUR.path],
      due: '2026-12-01',
      people: [{ name: 'Mara Quill', email: null, person: MARA.path }],
    },
  });

/** A capture that copies a task already in the vault, holding nothing it lacks. */
const duplicate = (text = '') =>
  preview({
    title: 'Renew Larkspur contract',
    text,
    answer: { duplicateOf: KEPT_PATH },
    tasks: [KEPT_TASK],
  });

/** A task that names someone new, with the address they are added under. */
const adding = (text = 'Lunch with Tobias Fenn <tobias@example.org> on Friday.\n') =>
  preview({
    title: 'Lunch with Tobias',
    text,
    answer: { people: [{ name: 'Tobias Fenn', email: 'tobias@example.org', person: null }] },
  });

describe('assistRecheck: rows it applies', () => {
  it('applies a task row as planned: made a task, its project and due filled, Mara linked', () => {
    const previewed = task();
    expect(previewed.row.step.kind).toBe('task');
    const checked = assistRecheck(recheckOf(previewed));
    expect(checked).toEqual({
      kind: 'apply',
      step: {
        path: previewed.row.path,
        title: 'Call Mara',
        fill: { makeTask: true, project: LARKSPUR, due: '2026-12-01' },
        links: [MARA],
        adds: [],
        duplicateOf: null,
      },
    });
  });

  it('applies a duplicate that holds nothing the kept task lacks', () => {
    const previewed = duplicate();
    expect(previewed.row.step).toMatchObject({ kind: 'duplicate', newerHolds: [] });
    const checked = assistRecheck(recheckOf(previewed));
    expect(checked).toMatchObject({ kind: 'apply', step: { duplicateOf: { path: KEPT_PATH } } });
  });

  it('applies an add the item names in its own words, under the address it gives', () => {
    const checked = assistRecheck(recheckOf(adding()));
    expect(checked).toMatchObject({
      kind: 'apply',
      step: { adds: [{ name: 'Tobias Fenn', email: 'tobias@example.org' }] },
    });
  });

  it('applies a duplicate whose kept task says it was made first', () => {
    const previewed = duplicate('---\ncreated: 2026-11-10\n---\n');
    expect(asked(assistRecheck(recheckOf(previewed)))).toBe('apply');
  });
});

describe('assistRecheck: it asks, and writes nothing, when', () => {
  it('the row is a question', () => {
    const previewed = preview({ title: 'Junk', text: 'Buy now\n', answer: { kind: 'junk' } });
    expect(asked(assistRecheck(recheckOf(previewed)))).toBe('not-appliable');
  });

  it('the task waits on someone: its status would be written over (preview-only)', () => {
    const previewed = preview({
      title: 'Wait for Mara',
      text: 'Waiting on Mara Quill.\n',
      answer: { waitingOn: MARA.path },
    });
    expect(previewed.row.step).toMatchObject({ kind: 'task', waitingOn: MARA });
    expect(asked(assistRecheck(recheckOf(previewed)))).toBe('not-appliable');
  });

  it('the item is gone', () => {
    expect(asked(assistRecheck(recheckOf(task(), { item: null })))).toBe('gone');
  });

  it('the item has typing not saved', () => {
    const previewed = task();
    const item = noteNow(previewed.text, { unsaved: true });
    expect(asked(assistRecheck(recheckOf(previewed, { item })))).toBe('unsaved');
  });

  it('the kept task has typing not saved', () => {
    const kept = { ...noteNow(KEPT_TEXT, { unsaved: true }), task: KEPT_TASK };
    expect(asked(assistRecheck(recheckOf(duplicate(), { kept })))).toBe('unsaved');
  });

  it('the item changed in the last 10 minutes, or says a time ahead of the clock', () => {
    const previewed = task();
    for (const modified of [NOW - 60_000, NOW + 60_000]) {
      const item = noteNow(previewed.text, { modified });
      expect(asked(assistRecheck(recheckOf(previewed, { item })))).toBe('recent');
    }
    const settled = noteNow(previewed.text, { modified: NOW - 10 * 60_000 });
    expect(asked(assistRecheck(recheckOf(previewed, { item: settled })))).toBe('apply');
  });

  it('the kept task changed in the last 10 minutes', () => {
    const kept = { ...noteNow(KEPT_TEXT, { modified: NOW - 1_000 }), task: KEPT_TASK };
    expect(asked(assistRecheck(recheckOf(duplicate(), { kept })))).toBe('recent');
  });

  it('a read was cut short', () => {
    expect(asked(assistRecheck(recheckOf(task(), { cut: true })))).toBe('read-cut');
  });

  it('the frontmatter cannot be read', () => {
    const previewed = task();
    const item = noteNow(previewed.text, { properties: null });
    expect(asked(assistRecheck(recheckOf(previewed, { item })))).toBe('unreadable');
  });

  it('a field it would fill is written now', () => {
    const previewed = task();
    for (const field of ['due: 2026-12-05', 'project: "[[Fenn Renovation]]"', 'status: next-action', 'people: Tobias Fenn']) {
      const item = noteNow(`---\n${field}\n---\n${previewed.text}`);
      const checked = assistRecheck(recheckOf(previewed, { item }));
      expect(asked(checked)).toBe('field-written');
      expect(checked).toMatchObject({ words: expect.stringContaining(field.split(':')[0]!) });
    }
  });

  it('a duplicate’s stamp is written already', () => {
    const item = noteNow('---\natlas_duplicate_of: "[[Something else]]"\n---\n');
    expect(asked(assistRecheck(recheckOf(duplicate(), { item })))).toBe('field-written');
  });

  it('the kept task is gone, or no longer an open task', () => {
    expect(asked(assistRecheck(recheckOf(duplicate(), { kept: null })))).toBe('kept-not-open');
    const done = { ...noteNow(KEPT_TEXT), task: null };
    expect(asked(assistRecheck(recheckOf(duplicate(), { kept: done }, [])))).toBe('kept-not-open');
  });

  it('the kept task was made after the copy, or says when in words that are no time', () => {
    const previewed = duplicate('---\ncreated: 2026-10-20\n---\n');
    expect(asked(assistRecheck(recheckOf(previewed)))).toBe('kept-newer');
    const unread = { ...noteNow('---\ncreated: last week\n---\n'), task: KEPT_TASK };
    expect(asked(assistRecheck(recheckOf(duplicate(), { kept: unread })))).toBe('kept-newer');
  });

  it('the kept task now differs from the copy', () => {
    const filed = { ...KEPT_TASK, project: LARKSPUR.path };
    const checked = assistRecheck(recheckOf(duplicate(), {}, [filed]));
    expect(asked(checked)).toBe('kept-differs');
    expect(checked).toMatchObject({ words: expect.stringContaining('Renew Larkspur contract') });
  });

  it('the copy holds anything the kept task lacks, computed afresh', () => {
    const previewed = duplicate('Call them first.\n');
    expect(previewed.row.step).toMatchObject({ kind: 'duplicate', newerHolds: ['body'] });
    const checked = assistRecheck(recheckOf(previewed));
    expect(asked(checked)).toBe('newer-holds');
    expect(checked).toMatchObject({ words: expect.stringContaining('(body)') });
  });

  it('the person to add is in People now, exactly or nearly, the Archive included', () => {
    const previewed = adding();
    for (const path of ['People/Tobias Fenn.md', 'Archive/People/Toby Fenn.md']) {
      const directory = [
        MARA_CANDIDATE,
        { path: path as never, name: 'Tobias Fenn', emails: ['tobias@example.org'], aliases: [] },
      ];
      const vault = { ...VAULT, directory };
      expect(asked(assistRecheck(recheckOf(previewed, { vault })))).toBe('person-exists');
    }
  });

  it('a note has the new person’s name as its title now', () => {
    const vault = { ...VAULT, takenTitles: new Set(['tobiasfenn']) };
    expect(asked(assistRecheck(recheckOf(adding(), { vault })))).toBe('title-taken');
  });

  it('the item’s text no longer names the person linked', () => {
    const previewed = preview({
      title: 'Ask about invoices',
      text: 'Ask mara.quill@example.com about the invoices.\n',
      answer: { people: [{ name: 'Mara', email: null, person: MARA.path }] },
    });
    expect(previewed.row.people).toEqual([{ kind: 'link', person: MARA }]);
    // Her address in People changed: the item's address is no longer hers, nor her name in it.
    const vault = { ...VAULT, directory: [{ ...MARA_CANDIDATE, emails: ['mara@example.com'] }] };
    const checked = assistRecheck(recheckOf(previewed, { vault }));
    expect(asked(checked)).toBe('evidence-gone');
  });

  it('a person is named only in a forwarded header', () => {
    const previewed = adding(
      'Worth a look.\n\n---------- Forwarded message ---------\nFrom: Tobias Fenn <tobias@example.org>\nSubject: Lunch\n\nLunch on Friday?\n',
    );
    expect(previewed.row.people).toEqual([{ kind: 'add', name: 'Tobias Fenn', email: 'tobias@example.org' }]);
    expect(asked(assistRecheck(recheckOf(previewed)))).toBe('quoted-only');
  });

  it('a person is named only in quoted lines', () => {
    const previewed = adding('See below.\n\n> Lunch with Tobias Fenn <tobias@example.org>?\n');
    expect(previewed.row.people).toHaveLength(1);
    expect(asked(assistRecheck(recheckOf(previewed)))).toBe('quoted-only');
  });

  it('the due date is not written in the item’s own words', () => {
    const previewed = preview({
      title: 'Renew it',
      text: 'Renew it before December.\n',
      answer: { due: '2026-12-01' },
    });
    expect(previewed.row.step).toMatchObject({ kind: 'task', due: '2026-12-01' });
    expect(asked(assistRecheck(recheckOf(previewed)))).toBe('due-unconfirmed');
  });

  it('the due date is written only in quoted text', () => {
    const previewed = preview({
      title: 'Renew it',
      text: 'Renew it.\n\n> They want it by 2026-12-01.\n',
      answer: { due: '2026-12-01' },
    });
    expect(asked(assistRecheck(recheckOf(previewed)))).toBe('quoted-only');
  });

  it('the plan made again from the vault now is not the plan shown', () => {
    // Larkspur Payroll is no longer a project anything is filed under.
    const vault = { ...VAULT, filingTargets: [] };
    const checked = assistRecheck(recheckOf(task(), { vault }));
    expect(asked(checked)).toBe('plan-changed');
    expect(checked).toMatchObject({ words: expect.stringContaining('question') });
  });

  it('the item says anything other than at the preview', () => {
    const previewed = task();
    const item = noteNow(`${previewed.text}Also: bring the letter.\n`);
    expect(asked(assistRecheck(recheckOf(previewed, { item })))).toBe('item-changed');
  });

  it('the kept task says anything other than at the preview', () => {
    const kept = { ...noteNow(`${KEPT_TEXT}One more line.\n`), task: KEPT_TASK };
    expect(asked(assistRecheck(recheckOf(duplicate(), { kept })))).toBe('kept-changed');
    const unread = { ...duplicate(), evidence: { ...duplicate().evidence, kept: null } };
    expect(asked(assistRecheck(recheckOf(unread)))).toBe('kept-changed');
  });
});
