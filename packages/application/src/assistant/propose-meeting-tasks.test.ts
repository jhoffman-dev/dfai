/**
 * `propose_tasks(meeting)` (P32-05): the meeting extraction (P29-05) run on
 * demand for one meeting, over the Gemini fixture meeting in a vault held in
 * memory whose index answers with real SQL, and a scripted model in place of
 * Claude. What is asked, what lands in the Inbox — and nothing else — and
 * that asking again proposes nothing twice, are what is asserted.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  builtInPromptAt,
  createVaultPath,
  digestOf,
  MEETING_EXTRACTION_PROMPT,
  meetingDraftDigest,
  parseObjectType,
  splitFrontmatter,
  type AutomationRule,
} from '@dfai/domain';
import { ClaudeStepFailed } from '../automations/claude-step.ts';
import { runAutomation } from '../automations/run-automation.ts';
import type { ModelEvent } from '../chat/ports.ts';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
import { listProposals } from '../proposals/list-proposals.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import type { ScriptedRound } from '../testing/fake-model.ts';
import { MeetingGoneError, proposeMeetingTasks } from './propose-meeting-tasks.ts';
import { AssistantEntityError } from './read-entity.ts';

const TODAY = '2026-10-11';
const SYNC = 'Meetings/Platform weekly sync.md';

const GEMINI = jsonNote(
  {
    type: 'meeting',
    atlas_import: 'meeting/v1',
    atlas_import_outcome: 'imported',
    title: 'Platform weekly sync',
    date: '2026-09-29',
    start: '10:00',
    provider: 'gemini',
    external_id: 'gemini-7f3a9c21',
    attendees: [
      { name: 'Mara Quill', email: 'mara.quill@example.com' },
      { name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
    ],
  },
  splitFrontmatter(
    readFileSync(
      new URL(
        '../../../domain/src/meetings/fixtures/valid/gemini-platform-sync.md',
        import.meta.url,
      ),
      'utf8',
    ),
  ).body,
);

const relation = (target: string) => ({ kind: 'relation', target, many: true });
const TYPE_FILES = {
  meeting: { provider: 'text', tasks: relation('task'), decisions: relation('decision') },
  task: {
    status: { kind: 'select', options: ['inbox', 'next-action', 'waiting', 'archive'] },
    waiting_on: { kind: 'relation', target: 'person' },
    due: 'date',
  },
  decision: { meeting: { kind: 'relation', target: 'meeting' } },
  person: {},
};
const TYPES = Object.entries(TYPE_FILES).map(([name, properties]) =>
  parseObjectType({ name, label: name, properties }),
);

const NOTES = {
  [SYNC]: GEMINI,
  'People/Mara Quill.md': jsonNote({ type: 'person', email: 'mara.quill@example.com' }, ''),
  'People/Tobias Fenn.md': jsonNote({ type: 'person', email: 'tobias.fenn@example.com' }, ''),
  'Tasks/Write it up.md': jsonNote({ type: 'task', status: 'inbox' }, ''),
  [MEETING_EXTRACTION_PROMPT]: builtInPromptAt(MEETING_EXTRACTION_PROMPT)!.contents,
  ...Object.fromEntries(
    Object.entries(TYPE_FILES).map(([name, properties]) => [
      `.atlas/types/${name}.md`,
      jsonNote({ name, properties }, ''),
    ]),
  ),
};

const item = (fields: Record<string, unknown>) => ({ confidence: 'high', owner: '', ...fields });
const says = (...items: unknown[]): ModelEvent[] => [
  { type: 'text', text: JSON.stringify({ items }) },
];
const FROM_SYNC = says(
  item({
    kind: 'task',
    title: 'Write the rollout note',
    owner: 'Mara Quill',
    source_block: 't0003',
  }),
  item({ kind: 'task', title: 'Flag the new cache', owner: 'Tobias Fenn', source_block: 't0002' }),
  item({
    kind: 'task',
    title: 'Cite a turn that is not there',
    owner: 'Mara Quill',
    source_block: 't9999',
  }),
);

function setUp(rounds: readonly ScriptedRound[]) {
  const claude = fakeClaudeStepPorts({ rounds, today: TODAY, selfName: 'Mara Quill' });
  const vault = automationVault({ notes: { ...NOTES }, today: TODAY, types: TYPES, claude });
  const propose = (meeting = SYNC) =>
    proposeMeetingTasks({
      ports: vault.ports,
      claude,
      meeting: createVaultPath(meeting),
      madeBy: 'Claude, in the chat',
    });
  const outsideTheInbox = () =>
    vault.log.filter((line) => !line.startsWith('create Inbox/Proposals/'));
  return { claude, vault, propose, outsideTheInbox };
}

describe('proposeMeetingTasks', () => {
  it('drafts the meeting’s items as proposals citing their turns, and writes nothing else', async () => {
    const { vault, propose, outsideTheInbox } = setUp([FROM_SYNC]);

    const drafted = await propose();

    expect(drafted.proposed).toHaveLength(2);
    expect(drafted.alreadyProposed).toBe(0);
    expect(drafted.dropped).toEqual([
      expect.objectContaining({ title: 'Cite a turn that is not there' }),
    ]);
    // Nothing besides proposals: no task made, no meeting changed, not even with `apply` left out.
    expect(outsideTheInbox()).toEqual([]);
    const { open } = await listProposals({ fs: vault.ports.fs, markdown: vault.ports.markdown });
    expect(
      open.map(({ proposal }) => [proposal.kind, proposal.source, proposal.madeBy]).sort(),
    ).toEqual([
      ['task', '[[Platform weekly sync#^t0002]]', 'Claude, in the chat'],
      ['task', '[[Platform weekly sync#^t0003]]', 'Claude, in the chat'],
    ]);
  });

  it('asks the meeting-extraction prompt about this one meeting, with no tools', async () => {
    const { claude, propose } = setUp([FROM_SYNC]);

    await propose();

    const [asked] = claude.fake.requests;
    expect(claude.fake.requests).toHaveLength(1);
    expect(asked?.tools).toEqual([]);
    expect(asked?.system).toContain('1. **Only real commitments.**');
    expect(asked?.system).toContain(`<vault_data note="${SYNC}">`);
    expect(asked?.system).not.toContain('<vault_data note="Tasks/Write it up.md">');
  });

  it('proposes nothing twice when asked again about the same meeting', async () => {
    const { vault, propose } = setUp([FROM_SYNC, FROM_SYNC]);

    const first = await propose();
    const again = await propose();

    expect(first.proposed).toHaveLength(2);
    expect(again).toMatchObject({ proposed: [], alreadyProposed: 2 });
    const { open } = await listProposals({ fs: vault.ports.fs, markdown: vault.ports.markdown });
    expect(open).toHaveLength(2);
  });

  it('does not ask Claude about words it drafted before, and asks again once they change', async () => {
    const { claude, vault, propose } = setUp([FROM_SYNC, FROM_SYNC]);
    await propose();

    // Accepting a task writes the meeting's frontmatter, not its words: still unchanged.
    vault.files.set(SYNC, GEMINI.replace('"type":"meeting"', '"type":"meeting","tasks":["[[x]]"]'));
    expect(await propose()).toMatchObject({ proposed: [], alreadyProposed: 2, unchanged: true });
    expect(claude.fake.requests).toHaveLength(1);

    vault.files.set(SYNC, `${GEMINI}\nA line added after the call.\n`);
    expect(await propose()).toMatchObject({ unchanged: false, alreadyProposed: 2 });
    expect(claude.fake.requests).toHaveLength(2);
  });

  it.each(['Inbox/Proposals/Scratch.md', 'Notes/Scratch.md'])(
    'is not suppressed by a note at %s that carries this meeting’s digest but is no proposal',
    async (path) => {
      const { claude, vault, propose } = setUp([FROM_SYNC]);
      const digest = meetingDraftDigest({
        meeting: { provider: 'gemini', externalId: 'gemini-7f3a9c21' },
        words: splitFrontmatter(GEMINI).body,
      });
      vault.files.set(path, jsonNote({ type: 'note', meeting_digest: digest }, ''));

      expect(await propose()).toMatchObject({ unchanged: false });
      expect(claude.fake.requests).toHaveLength(1);
    },
  );

  it('writes nothing when another meeting took the path while Claude drafted it', async () => {
    const claude = fakeClaudeStepPorts({
      rounds: [FROM_SYNC],
      today: TODAY,
      selfName: 'Mara Quill',
    });
    const vault = automationVault({ notes: { ...NOTES }, today: TODAY, types: TYPES, claude });

    const refused = await proposeMeetingTasks({
      ports: vault.ports,
      claude,
      meeting: createVaultPath(SYNC),
      madeBy: 'x',
      // The meeting drafted is deleted and a different one written at its path.
      beforeWrite: async () =>
        void vault.files.set(SYNC, GEMINI.replace('gemini-7f3a9c21', 'gemini-1234abcd')),
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(MeetingGoneError);
    expect((refused as Error).message).toBe(
      `${SYNC} is another meeting now, so nothing it proposed was written.`,
    );
    expect(vault.log.filter((line) => line.startsWith('create '))).toEqual([]);
  });

  it('keeps on each proposal the digest of the words it was drafted from', async () => {
    const { vault, propose } = setUp([FROM_SYNC]);
    const { proposed } = await propose();
    expect(vault.properties(proposed[0]!)['meeting_digest']).toBe(
      meetingDraftDigest({
        meeting: { provider: 'gemini', externalId: 'gemini-7f3a9c21' },
        words: splitFrontmatter(GEMINI).body,
      }),
    );
  });

  it('writes nothing when the caller’s check before writing refuses — a vault closed meanwhile', async () => {
    const claude = fakeClaudeStepPorts({
      rounds: [FROM_SYNC],
      today: TODAY,
      selfName: 'Mara Quill',
    });
    const vault = automationVault({ notes: { ...NOTES }, today: TODAY, types: TYPES, claude });
    const closed = new Error('The vault this request was for is no longer open');

    await expect(
      proposeMeetingTasks({
        ports: vault.ports,
        claude,
        meeting: createVaultPath(SYNC),
        madeBy: 'x',
        beforeWrite: () => Promise.reject(closed),
      }),
    ).rejects.toBe(closed);
    expect(vault.log.filter((line) => line.startsWith('create '))).toEqual([]);
  });

  it('writes nothing when the meeting went while Claude drafted it', async () => {
    const claude = fakeClaudeStepPorts({
      rounds: [FROM_SYNC],
      today: TODAY,
      selfName: 'Mara Quill',
    });
    const vault = automationVault({ notes: { ...NOTES }, today: TODAY, types: TYPES, claude });

    await expect(
      proposeMeetingTasks({
        ports: vault.ports,
        claude,
        meeting: createVaultPath(SYNC),
        madeBy: 'x',
        beforeWrite: async () => void vault.files.delete(SYNC),
      }),
    ).rejects.toBeInstanceOf(MeetingGoneError);
    expect(vault.log.filter((line) => line.startsWith('create '))).toEqual([]);
  });

  it('proposes nothing the meeting extraction rule already proposed for the meeting', async () => {
    const { claude, vault, propose } = setUp([FROM_SYNC, FROM_SYNC]);
    const rule: AutomationRule = {
      id: 'Meeting extraction',
      path: createVaultPath('.atlas/automations/Meeting extraction.md'),
      name: 'Meeting extraction',
      enabled: true,
      when: { kind: 'manual' },
      which: 'FROM meeting',
      olderThanDays: null,
      action: {
        kind: 'claude',
        prompt: MEETING_EXTRACTION_PROMPT,
        tools: [],
        output: { kind: 'proposals', schema: 'meeting-items' },
      },
    };
    await runAutomation({
      ports: { ...vault.ports, claude },
      rule,
      clock: { today: () => TODAY, localNow: () => `${TODAY}T09:00:00`, now: () => 0 },
      guard: { vault: '/v', currentVault: () => '/v' },
      activity: recordingActivity(),
      trigger: 'hand',
    });

    expect(await propose()).toMatchObject({ proposed: [], alreadyProposed: 2 });
  });

  it('refuses a note that is not a meeting, or is not there, without asking Claude', async () => {
    const { claude, propose, vault } = setUp([FROM_SYNC]);
    const before = [...vault.files.keys()];

    await expect(propose('Tasks/Write it up.md')).rejects.toEqual(
      new AssistantEntityError('not_a_page', 'Tasks/Write it up.md is not a meeting note.'),
    );
    await expect(propose('Meetings/Gone.md')).rejects.toMatchObject({ reason: 'not_found' });
    expect(claude.fake.requests).toHaveLength(0);
    expect([...vault.files.keys()]).toEqual(before);
  });

  it('fails as the step fails — Claude not ready — having written nothing', async () => {
    const claude = fakeClaudeStepPorts({
      status: { ready: false, reason: 'not signed in' } as never,
    });
    const vault = automationVault({ notes: { ...NOTES }, today: TODAY, types: TYPES, claude });

    await expect(
      proposeMeetingTasks({
        ports: vault.ports,
        claude,
        meeting: createVaultPath(SYNC),
        madeBy: 'x',
      }),
    ).rejects.toBeInstanceOf(ClaudeStepFailed);
    expect(vault.log).toEqual([]);
  });
});

/**
 * Verify pass on PR #549: the unchanged-meeting skip is keyed on the meeting's
 * words alone, not on which meeting they are, nor on the note being a proposal.
 */
describe('proposeMeetingTasks — the unchanged-meeting skip (verify-549)', () => {
  const COPY = 'Meetings/Platform weekly sync, second room.md';

  it('asks Claude about a second meeting whose words match one drafted before', async () => {
    const { claude, vault, propose } = setUp([FROM_SYNC, FROM_SYNC]);
    vault.files.set(COPY, GEMINI.replace('gemini-7f3a9c21', 'gemini-0000beef'));
    await propose();

    const second = await propose(COPY);

    expect(second.unchanged).toBe(false);
    expect(claude.fake.requests).toHaveLength(2);
  });

  it('is not suppressed by a note that is not a proposal carrying the digest', async () => {
    const { claude, vault, propose } = setUp([FROM_SYNC]);
    vault.files.set(
      'Notes/Scratch.md',
      jsonNote({ type: 'note', meeting_digest: digestOf(splitFrontmatter(GEMINI).body) }, ''),
    );

    const drafted = await propose();

    expect(drafted.unchanged).toBe(false);
    expect(claude.fake.requests).toHaveLength(1);
  });

  it('keeps the digest off the task Accept writes', async () => {
    const { vault, propose } = setUp([FROM_SYNC]);
    const { proposed } = await propose();

    const accepted = await acceptProposalNote({
      ports: vault.ports,
      path: proposed[0]!,
      today: TODAY,
      via: 'app',
    });

    const written = [...vault.files.keys()].filter((path) => path.startsWith('Tasks/'));
    expect(accepted).toBeTruthy();
    for (const path of written) {
      expect(vault.properties(createVaultPath(path))['meeting_digest']).toBeUndefined();
    }
    expect(vault.properties(createVaultPath(SYNC))['meeting_digest']).toBeUndefined();
  });
});
