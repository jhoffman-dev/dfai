/**
 * The way a Claude step's proposal links back to the meeting it came from
 * (P29-03 on P29-04, for P29-05): a schema's draft joins a relation of the
 * meeting it cites, the run names that meeting by the identity it read from
 * the file, the shared writer writes it, and Accept finds the meeting by that
 * identity wherever it has been filed since. Over a vault held in memory.
 */
import { describe, expect, it } from 'vitest';
import {
  answeredMeetingOf,
  checkDraft,
  claudeNewProposal,
  splitFrontmatter,
  type AnsweredNote,
  type ProposalDraft,
} from '@dfai/domain';
import { processInboxItems } from '../inbox/process-inbox.ts';
import { ensureBuiltInTypes } from '../types/ensure-built-in-types.ts';
import { MEETING_BODY } from '../testing/meeting-files.ts';
import {
  jsonLinesMarkdown,
  jsonLinesNote,
  proposalVault,
  vaultPath,
  type ProposalVault,
} from '../testing/proposal-vault.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { acceptProposalNote } from './accept-proposal.ts';
import { writeProposals } from './write-proposals.ts';

const TODAY = '2026-10-06';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
const PROJECT = 'Projects/Ledger migration.md';
const TASK = 'Tasks/2026/10/Send Mara the payroll file.md';

const meeting = (more: Record<string, unknown> = {}) =>
  jsonLinesNote(
    {
      type: 'meeting',
      atlas_import: 'meeting/v1',
      atlas_import_outcome: 'imported',
      title: 'Standup',
      date: '2026-10-06',
      start: '09:30',
      provider: 'gemini',
      external_id: 'gemini-7f3a9c21',
      attendees: [],
      ...more,
    },
    MEETING_BODY,
  );

const VAULT = {
  [MEETING]: meeting(),
  [PROJECT]: jsonLinesNote({ type: 'project', status: 'active' }),
  '.atlas/types/meeting.md': jsonLinesNote({
    name: 'meeting',
    properties: { tasks: { kind: 'relation', target: 'task', many: true } },
  }),
};

function filesOf(setup: ProposalVault): Record<string, string> {
  return Object.fromEntries([...setup.fixture.files].map(([path, note]) => [path, note.text]));
}

/** The ports with an index that has read every note as it is now. */
function fresh(setup: ProposalVault): ProposalVault['ports'] {
  const query = atlasQueryIndex({ files: filesOf(setup), markdown: jsonLinesMarkdown() });
  return { ...setup.ports, index: { ...setup.ports.index, query } };
}

/** The meeting as a run reads it: its text, and what its own frontmatter says it is. */
function answered(setup: ProposalVault): AnsweredNote {
  const text = filesOf(setup)[MEETING]!;
  const properties = setup.ports.markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
  const said = answeredMeetingOf(properties);
  return { path: vaultPath(MEETING), text, ...(said !== undefined && { meeting: said }) };
}

/** A task taken from the meeting's first turn, joining the meeting's `tasks`, written as a proposal. */
async function propose(setup: ProposalVault) {
  const draft: ProposalDraft = {
    kind: 'task',
    payload: { title: 'Send Mara the payroll file' },
    source: '[[2026-10-06 Standup#^t0001]]',
    confidence: 'high',
    why: 'Mara asked for it.',
    joinsMeeting: 'tasks',
  };
  const checked = checkDraft(draft, { notes: [answered(setup)] }, ['tasks']);
  if (!checked.ok) throw new Error(checked.problem);
  const proposal = claudeNewProposal({
    rule: 'Actions',
    madeBy: 'Actions',
    proposal: checked.value,
  });
  const { written } = await writeProposals({ ...fresh(setup), proposals: [proposal] });
  return written[0]!;
}

describe('a Claude step’s task that links back to its meeting', () => {
  it('makes the task citing its turn, and adds it to the meeting’s relation', async () => {
    const setup = proposalVault(VAULT);
    const path = await propose(setup);

    await acceptProposalNote({ via: 'app', ports: fresh(setup), path, today: TODAY });

    expect(setup.propertiesOf(TASK)).toEqual({
      type: 'task',
      source: '[[2026-10-06 Standup#^t0001]]',
    });
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
  });

  it('finds the meeting where it was filed since, by what it is', async () => {
    const setup = proposalVault(VAULT);
    const path = await propose(setup);
    const filed = await processInboxItems({
      ports: setup.ports,
      paths: [vaultPath(MEETING)],
      notePaths: setup.paths().map(vaultPath),
      project: vaultPath(PROJECT),
      today: TODAY,
      updateLinks: true,
    });
    const moved = filed.moves[0]?.move.to as string;
    // Filed out of the older Inbox/Meetings into the meeting's month (#214).
    expect(moved).toMatch(/^Meetings\/2026\/10\//);

    await acceptProposalNote({ via: 'app', ports: fresh(setup), path, today: TODAY });

    expect(setup.paths()).toContain(TASK);
    expect(setup.propertiesOf(moved)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
  });

  it('writes to no other meeting that has landed at the path since', async () => {
    const setup = proposalVault(VAULT);
    const path = await propose(setup);
    const other = meeting({ external_id: 'gemini-00000000', title: 'Another standup' });
    await setup.ports.fs.writeTextFile({
      path: vaultPath(MEETING),
      contents: other,
      expectedModified: null,
    });

    await expect(
      acceptProposalNote({ via: 'app', ports: fresh(setup), path, today: TODAY }),
    ).rejects.toThrow(/no longer the meeting this was proposed for/);

    expect(setup.paths()).not.toContain(TASK);
    expect(setup.propertiesOf(MEETING)?.['tasks']).toBeUndefined();
  });
});

describe('a vault whose Meeting type predates `tasks` (#162)', () => {
  const OLDER = {
    ...VAULT,
    '.atlas/types/meeting.md': jsonLinesNote(
      { name: 'meeting', label: 'Meeting', properties: { title: 'text' } },
      '\n# Meeting\n\nMara’s notes on meetings.\n',
    ),
  };

  it('is refused at Accept while the type lacks the relation', async () => {
    const setup = proposalVault(OLDER);
    const path = await propose(setup);

    await expect(
      acceptProposalNote({ via: 'app', ports: fresh(setup), path, today: TODAY }),
    ).rejects.toThrow(/has no relation called tasks to link through/);
  });

  it('accepts once the vault has been opened, linking the task back into the meeting', async () => {
    const setup = proposalVault(OLDER);
    const path = await propose(setup);

    const opened = await ensureBuiltInTypes(setup.ports);
    expect(opened.properties.gained.map((gained) => gained.added)).toEqual([
      [
        'Import',
        'Import error',
        'Duplicate of',
        'Tasks',
        'Decisions',
        'Summary digest',
        'Summary of',
        'Summary model',
      ],
    ]);
    // The migration's record is YAML (`atlas: migration`), which this vault's JSON-lines
    // markdown cannot read; Accept reads no note under `.atlas/migrations`, so it is left out.
    setup.fixture.files.delete('.atlas/migrations/type-properties.md');
    await acceptProposalNote({ via: 'app', ports: fresh(setup), path, today: TODAY });

    expect(setup.paths()).toContain(TASK);
    expect(setup.propertiesOf(MEETING)?.['tasks']).toEqual(['[[Send Mara the payroll file]]']);
  });
});
