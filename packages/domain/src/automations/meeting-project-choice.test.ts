import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { meetingProjectProposalId } from '../meeting-links/meeting-link-plan.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  MAX_PROJECT_CHOICES,
  projectChoiceData,
  projectChoiceOutcome,
  projectOptionsOf,
  readProjectChoice,
  surestProjectChoice,
  type ProjectChoice,
  type ProjectOption,
} from './meeting-project-choice.ts';
import type { AnsweredNote, AnswerContext } from './proposal-schema.ts';
import { proposalSchemaNamed } from './proposal-schemas.ts';

/**
 * #227: the "After a meeting" step's answer may choose, beside its items,
 * the project a meeting with none is filed under — one of the projects and
 * areas it was shown, never one it makes up.
 */

const MEETING: AnsweredNote = {
  path: createVaultPath('Inbox/Meetings/Platform weekly sync.md'),
  text: readFileSync(
    new URL('../meetings/fixtures/valid/gemini-platform-sync.md', import.meta.url),
    'utf8',
  ),
  meeting: { identity: { provider: 'gemini', externalId: 'gemini-7f3a9c21' }, attendees: [] },
};
const FILED: AnsweredNote = { ...MEETING, meeting: { ...MEETING.meeting!, filed: true } };

const OPTIONS: ProjectOption[] = [
  { path: createVaultPath('Projects/Ledger.md'), title: 'Ledger', para: 'project' },
  { path: createVaultPath('Areas/Operations.md'), title: 'Operations', para: 'area' },
];

const choose = (value: unknown, notes: readonly AnsweredNote[] = [MEETING]) =>
  readProjectChoice({ value, notes, options: OPTIONS });

const LEDGER_CHOICE = {
  path: 'Projects/Ledger.md',
  confidence: 'high',
  why: 'It is about the ledger.',
};

describe('readProjectChoice', () => {
  it('reads one of the options it was shown, with how sure and why', () => {
    expect(choose(LEDGER_CHOICE)).toEqual({
      ok: true,
      value: {
        project: 'Projects/Ledger.md',
        title: 'Ledger',
        confidence: 'high',
        why: 'It is about the ledger.',
      },
    });
    expect(choose(undefined)).toEqual({ ok: true, value: null });
  });

  it('leaves out a path it was not shown, and a choice with a fault', () => {
    expect(choose({ ...LEDGER_CHOICE, path: 'Projects/Made up.md' })).toMatchObject({ ok: false });
    expect(choose({ ...LEDGER_CHOICE, path: 'projects/ledger.md' })).toMatchObject({ ok: false });
    expect(choose({ ...LEDGER_CHOICE, confidence: 'certain' })).toMatchObject({ ok: false });
    expect(choose({ ...LEDGER_CHOICE, why: '' })).toMatchObject({ ok: false });
    expect(choose({ ...LEDGER_CHOICE, why: '![x](https://example.com/x.png)' })).toMatchObject({
      ok: false,
    });
    expect(choose({ ...LEDGER_CHOICE, folder: 'Projects' })).toMatchObject({ ok: false });
    expect(choose('Projects/Ledger.md')).toMatchObject({ ok: false });
  });

  it('leaves out any choice for a meeting filed already, or an ask about more than one note', () => {
    expect(choose(LEDGER_CHOICE, [FILED])).toMatchObject({ ok: false });
    expect(choose(LEDGER_CHOICE, [MEETING, MEETING])).toMatchObject({ ok: false });
  });
});

describe('projectChoiceData', () => {
  it('shows the options beside a meeting with no project, and nothing otherwise', () => {
    const [shown] = projectChoiceData({ notes: [MEETING], options: OPTIONS });
    expect(shown?.text).toBe(
      '- Projects/Ledger.md — Ledger (project)\n- Areas/Operations.md — Operations (area)',
    );
    expect(projectChoiceData({ notes: [FILED], options: OPTIONS })).toEqual([]);
    expect(projectChoiceData({ notes: [MEETING], options: [] })).toEqual([]);
  });
});

describe('a vault with more open projects and areas than one ask is shown (#793)', () => {
  /** Projects 000 to 199, in title order, as the options query returns them. */
  const many: ProjectOption[] = Array.from({ length: 200 }, (_, at) => ({
    path: createVaultPath(`Projects/Quillwort ${String(at).padStart(3, '0')}.md`),
    title: `Quillwort ${String(at).padStart(3, '0')}`,
    para: 'project' as const,
  }));
  const lastByTitle = many.at(-1)!.path;
  const ties = new Map([[MEETING.path, [lastByTitle, many[150]!.path]]]);
  const shownLines = (text: string) => text.split('\n').filter((line) => line.startsWith('- '));

  it('shows at most the cap, the ones tied to its people and companies first, and says the rest are cut', () => {
    const [shown] = projectChoiceData({ notes: [MEETING], options: many, ties });
    const lines = shownLines(shown!.text);

    expect(lines).toHaveLength(MAX_PROJECT_CHOICES);
    expect(lines[0]).toBe(`- ${lastByTitle} — Quillwort 199 (project)`);
    expect(lines[1]).toBe('- Projects/Quillwort 150.md — Quillwort 150 (project)');
    expect(lines[2]).toBe('- Projects/Quillwort 000.md — Quillwort 000 (project)');
    expect(shown!.text).toContain(
      `${MAX_PROJECT_CHOICES} of the 200 open projects and areas are shown`,
    );
  });

  it('never cuts the project linking would propose: the one most tied to its people', () => {
    const [shown] = projectChoiceData({ notes: [MEETING], options: many, ties });
    expect(shownLines(shown!.text)).toContain(`- ${lastByTitle} — Quillwort 199 (project)`);
    const chosen = readProjectChoice({
      value: { path: lastByTitle, confidence: 'high', why: 'Its people work on it.' },
      notes: [MEETING],
      options: many,
      ties,
    });
    expect(chosen).toMatchObject({ ok: true, value: { project: lastByTitle } });
  });

  it('refuses a choice it was not shown, though the vault has it open', () => {
    const cutOff = many[100]!.path;
    expect(
      readProjectChoice({
        value: { path: cutOff, confidence: 'high', why: 'It fits.' },
        notes: [MEETING],
        options: many,
        ties,
      }),
    ).toMatchObject({ ok: false });
  });

  it('shows a tie only once, ignores one that is not open, and says nothing of a cut when all fit', () => {
    const [shown] = projectChoiceData({
      notes: [MEETING],
      options: OPTIONS,
      ties: new Map([
        [MEETING.path, [OPTIONS[1]!.path, OPTIONS[1]!.path, createVaultPath('Projects/Done.md')]],
      ]),
    });
    expect(shown?.text).toBe(
      '- Areas/Operations.md — Operations (area)\n- Projects/Ledger.md — Ledger (project)',
    );
  });
});

describe('projectOptionsOf', () => {
  it('keeps the open projects and areas, never a resource, an archived or a finished one', () => {
    const row = (path: string, more: Record<string, string | null> = {}) => ({
      path,
      title: path,
      type: 'project',
      para: null,
      status: null,
      ...more,
    });
    const options = projectOptionsOf([
      row('Projects/Ledger.md'),
      row('Areas/Operations.md', { para: 'area' }),
      row('Areas/Old style.md', { type: 'area' }),
      row('Resources/Guide.md', { para: 'resource' }),
      row('Projects/Gone.md', { para: 'archive' }),
      row('Archive/Projects/Old.md'),
      row('Projects/Done.md', { status: 'done' }),
    ]);
    expect(options.map((option) => [option.path, option.para])).toEqual([
      ['Projects/Ledger.md', 'project'],
      ['Areas/Operations.md', 'area'],
      ['Areas/Old style.md', 'area'],
    ]);
  });
});

describe('surestProjectChoice', () => {
  const choice = (confidence: ProjectChoice['confidence'], title: string): ProjectChoice => ({
    project: createVaultPath(`Projects/${title}.md`),
    title,
    confidence,
    why: 'Because.',
  });

  it('takes the surest of a meeting’s parts, the first of those as sure', () => {
    expect(
      surestProjectChoice([null, choice('medium', 'A'), choice('high', 'B'), choice('high', 'C')])
        ?.title,
    ).toBe('B');
    expect(surestProjectChoice([null, null])).toBeNull();
  });

  it('files nothing when its parts chose different projects: the surest is proposed, at medium', () => {
    expect(surestProjectChoice([choice('high', 'Ledger'), choice('high', 'Payrun')])).toEqual({
      project: createVaultPath('Projects/Ledger.md'),
      title: 'Ledger',
      confidence: 'medium',
      why: 'Because. Other parts of the meeting chose Payrun.',
    });
    expect(
      surestProjectChoice([choice('high', 'Ledger'), choice('low', 'Payrun')])?.confidence,
    ).toBe('medium');
    expect(
      surestProjectChoice([choice('low', 'Ledger'), choice('low', 'Payrun')])?.confidence,
    ).toBe('low');
  });

  it('stays sure when every part chose the same project', () => {
    expect(
      surestProjectChoice([choice('medium', 'Ledger'), null, choice('high', 'Ledger')]),
    ).toMatchObject({ title: 'Ledger', confidence: 'high', why: 'Because.' });
  });
});

describe('projectChoiceOutcome', () => {
  const meeting = {
    path: MEETING.path,
    identity: { provider: 'gemini', externalId: 'gemini-7f3a9c21' },
    project: undefined,
  };
  const choice = (confidence: ProjectChoice['confidence']): ProjectChoice => ({
    project: createVaultPath('Projects/Ledger.md'),
    title: 'Ledger',
    confidence,
    why: 'It is about the ledger.',
  });
  const notePaths = [MEETING.path, createVaultPath('Projects/Ledger.md')];
  const outcome = (confidence: ProjectChoice['confidence'], project: unknown = undefined) =>
    projectChoiceOutcome({
      meeting: { ...meeting, project },
      choice: choice(confidence),
      notePaths,
      madeBy: 'After a meeting',
    });

  it('files a meeting under a project Claude is sure of', () => {
    expect(outcome('high')).toEqual({ kind: 'file', link: '[[Ledger]]' });
    expect(outcome('high', '')).toEqual({ kind: 'file', link: '[[Ledger]]' });
    expect(outcome('high', [])).toEqual({ kind: 'file', link: '[[Ledger]]' });
  });

  it('otherwise proposes it once, under the id linking proposes a meeting’s project by', () => {
    const made = outcome('medium');
    expect(made).toMatchObject({
      kind: 'propose',
      proposal: {
        kind: 'link',
        confidence: 'medium',
        madeBy: 'After a meeting',
        id: meetingProjectProposalId(meeting.path, meeting.identity),
        reason: 'Claude’s choice: It is about the ledger.',
        payload: {
          note: MEETING.path,
          property: 'project',
          link: '[[Ledger]]',
          meeting: meeting.identity,
        },
      },
    });
    expect(meetingProjectProposalId(meeting.path, meeting.identity)).toBe(
      'meeting links:gemini/gemini-7f3a9c21:project',
    );
  });

  it('does nothing to a meeting filed since it was asked about', () => {
    expect(outcome('high', '[[Operations]]')).toEqual({ kind: 'none' });
    expect(outcome('low', ['[[Operations]]'])).toEqual({ kind: 'none' });
  });
});

describe('the meeting-items answer with a project (#227)', () => {
  const schema = proposalSchemaNamed('meeting-items')!;
  const context: AnswerContext = {
    notes: [MEETING],
    vault: {
      selfName: 'Mara Quill',
      selfEmails: [],
      people: [],
      notePaths: [],
      terms: [],
      projects: OPTIONS,
    },
  };

  it('tells the model it may choose one, beside the list', () => {
    expect(schema.instructions).toContain('"project": { "path": one of those paths');
  });

  it('reads the choice beside the items', () => {
    const reading = schema.read(JSON.stringify({ items: [], project: LEDGER_CHOICE }), context);
    expect(reading).toMatchObject({ ok: true, project: { title: 'Ledger', confidence: 'high' } });
  });

  it('leaves out a choice that does not read, and says so, keeping the answer', () => {
    const reading = schema.read(
      JSON.stringify({ items: [], project: { ...LEDGER_CHOICE, path: 'Projects/Nope.md' } }),
      context,
    );
    expect(reading).toMatchObject({ ok: true, project: null });
    expect(reading.ok && reading.dropped.map((each) => each.title)).toEqual(['its project']);
  });

  it('is still refused by the general output, which chooses no project', () => {
    const general = proposalSchemaNamed('proposals')!;
    expect(
      general.read(JSON.stringify({ proposals: [], project: LEDGER_CHOICE }), context),
    ).toMatchObject({
      ok: false,
    });
  });
});
