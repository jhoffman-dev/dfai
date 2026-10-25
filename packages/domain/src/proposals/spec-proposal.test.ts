import { describe, expect, it } from 'vitest';
import { parseObjectType } from '../types/property-def.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { applyProposal } from './apply-proposal.ts';
import { proposalFileFor } from './new-proposal.ts';
import {
  acceptRefusal,
  isNoteProposal,
  isSpecProposal,
  proposalHeadline,
  readProposal,
  type ProposalNote,
} from './proposal.ts';
import { applySpecProposal, checkSpec, specProposalFor, specSummary } from './spec-proposal.ts';

const TYPES = [
  parseObjectType({
    name: 'task',
    label: 'Task',
    properties: { status: { kind: 'select', options: ['inbox', 'done'] }, due: 'date' },
  }),
];

const DASHBOARD = {
  kind: 'dashboard',
  name: 'Larkspur Payroll',
  widgets: [{ kind: 'bar', type: 'task', groupBy: 'status' }],
};
const VIEW = { kind: 'view', name: 'Open tasks', type: 'task', layout: 'board' };

function checked(spec: unknown) {
  const reading = checkSpec(spec, { types: TYPES });
  if (!reading.ok) throw new Error(JSON.stringify(reading.problems));
  return reading.checked;
}

/** The proposal as it is read back from its note in the Inbox. */
function asRead(spec: unknown): ProposalNote {
  const file = proposalFileFor(specProposalFor({ checked: checked(spec), madeBy: 'Claude' }));
  const reading = readProposal({ path: file.path, properties: file.properties });
  if (!reading.ok) throw new Error(reading.problem);
  return reading.proposal;
}

describe('checkSpec', () => {
  it('sends a dashboard to the widget checker and a view to the New view checker', () => {
    expect(checked(DASHBOARD)).toEqual({
      kind: 'dashboard',
      payload: {
        title: 'Larkspur Payroll',
        spec: { widgets: [{ kind: 'bar', type: 'task', groupBy: 'status' }] },
      },
    });
    expect(checked(VIEW)).toEqual({
      kind: 'view',
      payload: { title: 'Open tasks', spec: { type: 'task', layout: 'board' } },
    });
  });

  it.each([
    [null, 'spec'],
    [['a'], 'spec'],
    [{ name: 'x' }, 'kind'],
    [{ kind: 'note', name: 'x' }, 'kind'],
  ])('refuses %j at %s', (spec, at) => {
    const reading = checkSpec(spec, { types: TYPES });
    expect(reading.ok ? [] : reading.problems.map((problem) => problem.at)).toEqual([at]);
  });

  it('passes on the checker’s problems unchanged', () => {
    expect(checkSpec({ ...VIEW, type: 'deal' }, { types: TYPES })).toEqual({
      ok: false,
      problems: [{ at: 'type', message: 'That type no longer exists.' }],
    });
  });
});

describe('a dashboard or view proposal', () => {
  it('reads back from its note as what was checked, and is neither a note nor a link', () => {
    const proposal = asRead(DASHBOARD);

    expect(proposal).toMatchObject({ kind: 'dashboard', state: 'open', source: null });
    expect(isSpecProposal(proposal)).toBe(true);
    expect(isNoteProposal(proposal)).toBe(false);
    expect(proposalHeadline(proposal)).toBe('Larkspur Payroll');
  });

  it.each([
    [{ title: 'Board', spec: 'all of it' }, 'Its payload’s spec must be keys and values.'],
    [{ title: 'Board' }, 'Its payload’s spec must be keys and values.'],
    [{ title: '  ', spec: {} }, 'Its payload needs a title.'],
  ])('is unreadable with the payload %j', (payload, problem) => {
    const read = readProposal({
      path: createVaultPath('Inbox/Proposals/Board.md'),
      properties: { type: 'proposal', kind: 'dashboard', payload },
    });
    expect(read).toEqual({ ok: false, problem });
  });

  it('is known by what it asks for: the same spec twice is one proposal, another is another', () => {
    const id = (spec: unknown) => specProposalFor({ checked: checked(spec), madeBy: 'x' }).id;

    expect(id(DASHBOARD)).toBe(id({ ...DASHBOARD, name: 'larkspur payroll' }));
    expect(id(DASHBOARD)).not.toBe(id({ ...DASHBOARD, name: 'Payroll' }));
    expect(id(DASHBOARD)).not.toBe(
      id({ ...DASHBOARD, widgets: [{ kind: 'donut', type: 'task', groupBy: 'status' }] }),
    );
    expect(id(VIEW)).not.toBe(id({ ...VIEW, layout: 'table' }));
  });
});

describe('applySpecProposal', () => {
  it('writes a dashboard into .atlas/dashboards, numbered past one of the same name', () => {
    const written = applySpecProposal(checked(DASHBOARD), {
      types: TYPES,
      takenPaths: [createVaultPath('.atlas/dashboards/larkspur payroll.md')],
    });

    expect(written).toEqual({
      ok: true,
      writes: [
        {
          kind: 'create',
          path: '.atlas/dashboards/Larkspur Payroll 2.md',
          properties: {
            atlas: 'dashboard',
            widgets: [{ kind: 'bar', type: 'task', groupBy: 'status' }],
          },
          body: '# Larkspur Payroll\n',
        },
      ],
    });
  });

  it('writes a view into .atlas/views as the New view dialog would', () => {
    const written = applySpecProposal(checked(VIEW), { types: TYPES, takenPaths: [] });

    expect(written.ok && written.writes[0]).toMatchObject({
      kind: 'create',
      path: '.atlas/views/Open tasks.md',
      properties: { atlas: 'view', type: 'task', layout: 'board', groupBy: 'status' },
    });
  });

  it('is checked again: a type gone since it was proposed refuses it, writing nothing', () => {
    expect(applySpecProposal(checked(DASHBOARD), { types: [], takenPaths: [] })).toEqual({
      ok: false,
      problem:
        'It no longer passes the dashboard checker. widgets[0]: There is no type called “task”.',
    });
  });

  it('takes its name from the title, so a renamed proposal writes the new name — still checked', () => {
    const renamed = { ...checked(VIEW), payload: { ...checked(VIEW).payload, title: 'Doing' } };
    const written = applySpecProposal(renamed, { types: TYPES, takenPaths: [] });
    expect(written.ok && written.writes[0]?.path).toBe('.atlas/views/Doing.md');

    const hidden = { ...renamed, payload: { ...renamed.payload, title: '.hidden' } };
    expect(applySpecProposal(hidden, { types: TYPES, takenPaths: [] }).ok).toBe(false);
  });

  it('is what applyProposal does for one, with the vault’s types and the folder’s entries', () => {
    const proposal = asRead(VIEW);
    const applied = applyProposal(proposal, {
      notePaths: [],
      target: null,
      types: TYPES,
      specPaths: [createVaultPath('.atlas/views/Open tasks.md')],
    });
    expect(applied.ok && applied.writes[0]?.path).toBe('.atlas/views/Open tasks 2.md');
    expect(
      applyProposal({ ...proposal, state: 'rejected' }, { notePaths: [], target: null }),
    ).toEqual({
      ok: false,
      problem: 'It was already rejected.',
    });
  });
});

describe('acceptRefusal', () => {
  it('lets only the app accept a dashboard or a view', () => {
    expect(acceptRefusal('dashboard', 'app')).toBeNull();
    expect(acceptRefusal('view', 'api')).toMatch(/written into \.atlas.*accept it in DFAI’s Inbox/);
    expect(acceptRefusal('dashboard', 'api')).not.toBeNull();
    expect(acceptRefusal('task', 'api')).toBeNull();
  });
});

describe('specSummary', () => {
  it('says each widget as Accept writes it: its filters, and a query whole', () => {
    const sql = "SELECT title FROM notes WHERE type = 'task'";
    const summary = specSummary({
      kind: 'dashboard',
      payload: {
        title: 'Board',
        spec: {
          widgets: [
            {
              kind: 'number',
              type: 'task',
              title: 'Open',
              filters: [{ key: 'status', operator: 'is', value: 'inbox' }],
              unknown: 'dropped',
            },
            { kind: 'sql', title: 'Raw', sql, show: 'table' },
            { kind: 'query', query: 'FROM task SORT due' },
          ],
        },
      },
    });

    expect(summary).toEqual({
      kind: 'dashboard',
      folder: '.atlas/dashboards',
      widgets: [
        { kind: 'number', title: 'Open', asks: null, filters: ['status is inbox'] },
        { kind: 'sql', title: 'Raw', asks: sql, filters: [] },
        { kind: 'query', title: '', asks: 'FROM task SORT due', filters: [] },
      ],
    });
  });

  it('says a view’s type and layout, and where it goes', () => {
    expect(specSummary(checked(VIEW))).toEqual({
      kind: 'view',
      folder: '.atlas/views',
      type: 'task',
      layout: 'board',
    });
  });
});
