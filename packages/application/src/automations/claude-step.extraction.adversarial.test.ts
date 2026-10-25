/**
 * Adversarial pass over meeting extraction (P29-05, #18, PR #102): a scripted
 * model answering as a sloppy or hostile one would, over the same in-memory
 * vault and fixture meetings `claude-step.extraction.test.ts` uses (its
 * harness is repeated here: it exports none). Each test states one invariant
 * and fails on the branch as attacked; the ones marked DESIGN are behaviours
 * the ADR does not rule on, written down as the question they raise.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  digestOf,
  meetingTranscriptOf,
  logPathFor,
  MAX_PROPOSALS_PER_ANSWER,
  MEETING_EXTRACTION_PROMPT,
  builtInPromptAt,
  parseObjectType,
  splitFrontmatter,
  type AutomationRule,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { acceptProposalNote, undoAcceptedProposal } from '../proposals/accept-proposal.ts';
import { listProposals } from '../proposals/list-proposals.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import type { ScriptedRound } from '../testing/fake-model.ts';
import { runAutomation } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-11';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };

/** A fixture meeting as the import leaves it, with its frontmatter as this vault's reader takes it. */
function fixtureMeeting(name: string, header: Record<string, unknown>): string {
  const text = readFileSync(
    new URL(`../../../domain/src/meetings/fixtures/valid/${name}`, import.meta.url),
    'utf8',
  );
  return jsonNote(
    { type: 'meeting', atlas_import: 'meeting/v1', atlas_import_outcome: 'imported', ...header },
    splitFrontmatter(text).body,
  );
}

const SYNC = 'Meetings/Platform weekly sync.md';
const CALL = 'Meetings/Vendor contract call.md';
const GEMINI_HEADER = {
  title: 'Platform weekly sync',
  date: '2026-09-29',
  start: '10:00',
  provider: 'gemini',
  external_id: 'gemini-7f3a9c21',
  attendees: [
    { name: 'Mara Quill', email: 'mara.quill@example.com' },
    { name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
    { name: 'platform-team', email: 'platform-team@example.com', group: true },
  ],
};
const GEMINI = fixtureMeeting('gemini-platform-sync.md', GEMINI_HEADER);
const GRANOLA = fixtureMeeting('granola-vendor-call.md', {
  title: 'Vendor contract call',
  date: '2026-10-01',
  start: '14:14',
  provider: 'granola',
  external_id: 'granola-0b52e8d4',
  transcript_clock: 'wall',
  attendees: [{ name: 'Lena Hart', email: 'lena.hart@example.org' }],
});

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
  term: {},
};
const TYPES = Object.entries(TYPE_FILES).map(([name, properties]) =>
  parseObjectType({ name, label: name, properties }),
);

/** Mara owns the vault; Tobias has a Person note; Lena has none. */
const NOTES = {
  [SYNC]: GEMINI,
  [CALL]: GRANOLA,
  'People/Mara Quill.md': jsonNote({ type: 'person', email: 'mara.quill@example.com' }, ''),
  'People/Tobias Fenn.md': jsonNote({ type: 'person', email: 'tobias.fenn@example.com' }, ''),
  'Terms/Larkspur Pay.md': jsonNote({ type: 'term', kind: 'product', variants: ['Lark Spur'] }, ''),
  [MEETING_EXTRACTION_PROMPT]: builtInPromptAt(MEETING_EXTRACTION_PROMPT)!.contents,
  ...Object.fromEntries(
    Object.entries(TYPE_FILES).map(([name, properties]) => [
      `.atlas/types/${name}.md`,
      jsonNote({ name, properties }, ''),
    ]),
  ),
};

const CLAUDE_ACTION = {
  kind: 'claude',
  prompt: MEETING_EXTRACTION_PROMPT,
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-items' },
} as const;

const rule = (which: string): AutomationRule => ({
  id: 'Meeting extraction',
  path: createVaultPath('.atlas/automations/Meeting extraction.md'),
  name: 'Meeting extraction',
  enabled: true,
  when: { kind: 'manual' },
  which,
  olderThanDays: null,
  action: CLAUDE_ACTION,
});
const SYNC_ONLY = rule('FROM meeting WHERE provider = gemini');
const BOTH = rule('FROM meeting');

/** What extraction knows the Gemini meeting by, whatever its frontmatter: its identity and what was said. */
const SYNC_KEY = `meeting:gemini:gemini-7f3a9c21:transcript:${digestOf(meetingTranscriptOf(GEMINI) ?? '')}`;

const item = (fields: Record<string, unknown>) => ({ confidence: 'high', owner: '', ...fields });
const says = (...items: unknown[]): ModelEvent[] => [
  { type: 'text', text: JSON.stringify({ items }) },
];

/** What a rule with the general `proposals` output answers when it has nothing to propose. */
const NOTHING_PROPOSED: ModelEvent[] = [{ type: 'text', text: JSON.stringify({ proposals: [] }) }];

const FROM_SYNC = says(
  item({
    kind: 'task',
    title: 'Write the rollout note',
    owner: 'Mara Quill',
    source_block: 't0003',
    due: '2026-10-02',
  }),
  item({ kind: 'task', title: 'Flag the new cache', owner: 'Tobias Fenn', source_block: 't0002' }),
  item({ kind: 'decision', title: 'Ship the cache behind a flag', source_block: 't0003' }),
  item({
    kind: 'follow-up',
    title: 'Check Friday still works',
    source_block: 't0004',
    confidence: 'medium',
  }),
);
function setUp(rounds: readonly ScriptedRound[], notes: Record<string, string> = NOTES) {
  const claude = fakeClaudeStepPorts({
    rounds,
    model: 'claude-opus-5-5',
    today: TODAY,
    selfName: 'Mara Quill',
  });
  const vault = automationVault({ notes: { ...notes }, today: TODAY, types: TYPES, claude });
  const activity = recordingActivity();
  const run = (which: AutomationRule) =>
    runAutomation({
      ports: vault.ports,
      rule: which,
      clock: CLOCK,
      guard: GUARD,
      activity,
      trigger: 'hand',
    });
  const proposals = async () => {
    const { open } = await listProposals({ fs: vault.ports.fs, markdown: vault.ports.markdown });
    return new Map(
      open.map((listed) => [
        listed.proposal.payload && 'title' in listed.proposal.payload
          ? listed.proposal.payload.title
          : '',
        listed,
      ]),
    );
  };
  const properties = (path: string) =>
    vault.ports.markdown.frontmatterProperties(
      splitFrontmatter(vault.files.get(path) ?? '').frontmatter,
    );
  const log = () => vault.files.get(logPathFor(BOTH.id)) ?? '';
  return {
    vault,
    claude,
    activity,
    run,
    proposals,
    properties,
    log,
    asked: () => claude.fake.requests,
  };
}

/** The Gemini meeting with `turns` more turns of about 400 characters, ids from t0005. */
function longMeeting(turns: number): string {
  let body = splitFrontmatter(GEMINI).body;
  for (let id = 5; id < 5 + turns; id += 1) {
    body += `\n**Tobias Fenn** [~00:10:00] Turn ${id}. ${'word '.repeat(75)}^t${String(id).padStart(4, '0')}\n`;
  }
  return `${GEMINI.slice(0, GEMINI.length - splitFrontmatter(GEMINI).body.length)}${body}`;
}

/** The open proposal notes, by path. */
const waiting = (files: ReadonlyMap<string, string>) =>
  [...files.keys()].filter((path) => path.startsWith('Inbox/Proposals/'));

/** Accepts, answering what it wrote — or the refusal, when it was refused. */
async function accepted(ports: Parameters<typeof acceptProposalNote>[0]['ports'], path: string) {
  try {
    return await acceptProposalNote({
      via: 'app',
      ports,
      path: createVaultPath(path),
      today: TODAY,
    });
  } catch (refusal) {
    return refusal as Error;
  }
}

describe('the most proposals one run makes', () => {
  it('is 25 however many parts the meeting was read in', async () => {
    const full = (turn: string) =>
      says(
        ...Array.from({ length: MAX_PROPOSALS_PER_ANSWER }, (_, at) =>
          item({ kind: 'task', title: `Job ${turn} ${at}`, owner: 'You', source_block: turn }),
        ),
      );
    const { run, vault, asked } = setUp([full('t0003'), full('t0060'), full('t0109')], {
      ...NOTES,
      [SYNC]: longMeeting(105),
    });

    await run(SYNC_ONLY);

    expect(asked()).toHaveLength(3);
    // "more is a model run away, not a meeting": three runaway answers are no less one.
    expect(waiting(vault.files).length).toBeLessThanOrEqual(MAX_PROPOSALS_PER_ANSWER);
  });
});

describe('two items of one title', () => {
  it('taken on by two people in one turn are both proposed, or the log says which was left out', async () => {
    const { run, vault, log } = setUp([
      says(
        item({ kind: 'task', title: 'Send the notes', owner: 'You', source_block: 't0003' }),
        item({
          kind: 'task',
          title: 'Send the notes',
          owner: 'Tobias Fenn',
          source_block: 't0003',
        }),
      ),
    ]);

    await run(SYNC_ONLY);

    const said = log().includes('dropped') || log().includes('left out');
    expect(waiting(vault.files).length === 2 || said).toBe(true);
  });

  it('accepting the second makes its task or is refused: it is never answered accepted with nothing written', async () => {
    const { run, vault, properties } = setUp([
      says(
        item({
          kind: 'task',
          title: 'Send the notes',
          owner: 'You',
          source_block: 't0003',
          due: '2026-10-02',
        }),
        item({
          kind: 'task',
          title: 'Send the notes',
          owner: 'Tobias Fenn',
          source_block: 't0004',
          due: '2026-10-09',
        }),
      ),
    ]);
    await run(SYNC_ONLY);
    const [mine, theirs] = waiting(vault.files);
    expect(properties(theirs!)['payload']).toMatchObject({ properties: { status: 'waiting' } });
    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(mine!),
      today: TODAY,
    });

    const second = await accepted(vault.ports, theirs!);

    const waitingOnTobias = [...vault.files.keys()].some(
      (path) =>
        properties(path)['type'] === 'task' && properties(path)['waiting_on'] === '[[Tobias Fenn]]',
    );
    expect(second instanceof Error || waitingOnTobias).toBe(true);
  });

  it('accepting a task does not file last year’s finished task of that title under the meeting in its place', async () => {
    const { run, vault, proposals, properties } = setUp([FROM_SYNC], {
      ...NOTES,
      'Write the rollout note.md': jsonNote(
        { type: 'task', status: 'archive', due: '2025-01-01' },
        'Last year’s rollout.\n',
      ),
    });
    await run(SYNC_ONLY);
    const proposal = (await proposals()).get('Write the rollout note')!.proposal;

    const answer = await accepted(vault.ports, proposal.path);

    const made = [...vault.files.keys()].some(
      (path) => properties(path)['type'] === 'task' && properties(path)['due'] === '2026-10-02',
    );
    // Either the commitment proposed exists as a task, or Accept said why not.
    expect(answer instanceof Error || made).toBe(true);
  });
});

describe('undoing an accept after another proposal of the same meeting was accepted', () => {
  it('takes back all of it or none of it: the meeting never lists a task that was taken back', async () => {
    const { run, vault, proposals, properties } = setUp([FROM_SYNC]);
    // The shared fake's Trash does nothing; here it takes the note away, as the host's does.
    const ports = {
      ...vault.ports,
      fs: {
        ...vault.ports.fs,
        trashEntry: async ({ path }: { path: string }) => {
          vault.files.delete(path);
        },
      },
    } as typeof vault.ports;
    await run(SYNC_ONLY);
    const made = await proposals();
    const first = await acceptProposalNote({
      via: 'app',
      ports,
      path: made.get('Write the rollout note')!.proposal.path,
      today: TODAY,
    });
    await acceptProposalNote({
      via: 'app',
      ports,
      path: made.get('Flag the new cache')!.proposal.path,
      today: TODAY,
    });
    expect(properties(SYNC)['tasks']).toEqual([
      '[[Write the rollout note]]',
      '[[Flag the new cache]]',
    ]);

    await undoAcceptedProposal({ ports, accepted: first }).catch((refusal: unknown) => refusal);

    const taskThere = vault.files.has('Tasks/2026/10/Write the rollout note.md');
    const listed = (properties(SYNC)['tasks'] as string[]).includes('[[Write the rollout note]]');
    expect(listed).toBe(taskThere);
  });
});

describe('a prompt note replaced by a huge file', () => {
  it('fails the run before Claude is asked: the system prompt is one command-line argument', async () => {
    // The notes are budgeted (120,000 characters) so "the whole of it stays well inside what an
    // argument may hold"; macOS allows about a megabyte for all of a command's arguments.
    const huge = `# Meeting extraction\n\n${'Pull out every commitment. '.repeat(120_000)}`;
    expect(huge.length).toBeGreaterThan(3_000_000);
    const { run, asked } = setUp([says()], { ...NOTES, [MEETING_EXTRACTION_PROMPT]: huge });

    const entry = await run(SYNC_ONLY);

    expect(asked()).toHaveLength(0);
    expect(entry.kind).toBe('failed');
  });
});

describe('DESIGN: the same meeting reaching Claude more than once', () => {
  it('two rules with the meeting-items output propose each commitment once between them', async () => {
    const { run, vault } = setUp([FROM_SYNC, FROM_SYNC]);
    const second: AutomationRule = {
      ...SYNC_ONLY,
      id: 'Meeting extraction 2',
      name: 'Meeting extraction 2',
      path: createVaultPath('.atlas/automations/Meeting extraction 2.md'),
    };

    await run(SYNC_ONLY);
    await run(second);

    expect(waiting(vault.files)).toHaveLength(4);
  });

  it('accepting a proposal does not make its meeting new to the rule that proposed it', async () => {
    const { run, vault, proposals, asked } = setUp([FROM_SYNC, says(), says()]);
    await run(SYNC_ONLY);
    await run(SYNC_ONLY);
    // Unchanged, the meeting is not asked about again.
    expect(asked()).toHaveLength(1);
    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: (await proposals()).get('Write the rollout note')!.proposal.path,
      today: TODAY,
    });

    await run(SYNC_ONLY);

    // Accept's own write of `tasks` is the only change: DFAI's, not what was said in the meeting.
    expect(asked()).toHaveLength(1);
  });

  it('the same words delivered again under other frontmatter are not asked about again; other words are', async () => {
    const { run, vault, log, asked } = setUp([FROM_SYNC, says(), says()]);
    await run(SYNC_ONLY);
    // The ledger p29-03 keeps is the only memory: the meeting's key is in it, under its marker.
    const ledger = log().slice(log().indexOf('<!-- atlas:handled-ledger v1 -->'));
    expect(ledger).toContain(SYNC_KEY);

    const redelivered = fixtureMeeting('gemini-platform-sync.md', {
      ...GEMINI_HEADER,
      summary_model: 'gemini-2.5',
    });
    expect(redelivered).not.toBe(vault.files.get(SYNC));
    vault.files.set(SYNC, redelivered);
    await run(SYNC_ONLY);

    expect(asked()).toHaveLength(1);

    vault.files.set(SYNC, `${redelivered}\n**Tobias Fenn** [~00:20:00] One more thing. ^t0005\n`);
    await run(SYNC_ONLY);

    expect(asked()).toHaveLength(2);
  });

  it('a meeting another rule has answered is still new to extraction, and each log holds its own', async () => {
    const { run, vault, asked } = setUp([NOTHING_PROPOSED, FROM_SYNC, says(), says()]);
    const general: AutomationRule = {
      ...SYNC_ONLY,
      id: 'Meeting notes',
      name: 'Meeting notes',
      path: createVaultPath('.atlas/automations/Meeting notes.md'),
      action: { ...CLAUDE_ACTION, output: { kind: 'proposals', schema: 'proposals' } },
    };

    await run(general);
    await run(SYNC_ONLY);

    // Handled by the general rule is not handled by extraction: it is asked, and proposes.
    expect(asked()).toHaveLength(2);
    expect(waiting(vault.files)).toHaveLength(4);
    // Only extraction knows the meeting by its words; the general rule by its bytes alone.
    expect(vault.files.get(logPathFor(general.id))).toContain('- answered');
    expect(vault.files.get(logPathFor(general.id))).not.toContain(SYNC_KEY);
    expect(vault.files.get(logPathFor(SYNC_ONLY.id))).toContain(SYNC_KEY);

    await run(general);
    await run(SYNC_ONLY);

    expect(asked()).toHaveLength(2);
  });

  it('accepting a waiting-for whose Person note has gone does not make a task waiting on a link to nothing', async () => {
    const { run, vault, proposals, properties } = setUp([FROM_SYNC]);
    await run(SYNC_ONLY);
    const proposal = (await proposals()).get('Flag the new cache')!.proposal;
    // Renamed on the other Mac: the note the proposal links is no longer there.
    const tobias = vault.files.get('People/Tobias Fenn.md')!;
    vault.files.delete('People/Tobias Fenn.md');
    vault.files.set('People/Tobias Fenn-Reed.md', tobias);

    const answer = await accepted(vault.ports, proposal.path);

    const waitingOn = properties('Flag the new cache.md')['waiting_on'];
    expect(answer instanceof Error || waitingOn !== '[[Tobias Fenn]]').toBe(true);
  });
});
