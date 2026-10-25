/**
 * Meeting extraction (P29-05, ADR-0028): a rule whose Claude step answers
 * with `meeting-items`, over the Gemini and Granola fixture meetings in a
 * vault held in memory whose index answers with real SQL, and a scripted
 * model in place of Claude. What is asked, what each answer becomes in the
 * Inbox, what the log says was left out, and what accepting a proposal
 * writes are what is asserted.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_ASKS_PER_RUN,
  CLAUDE_NOTE_CHARACTERS,
  createVaultPath,
  logPathFor,
  MEETING_EXTRACTION_PROMPT,
  builtInPromptAt,
  parseObjectType,
  parseRunLog,
  splitFrontmatter,
  type AutomationRule,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
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
const GEMINI = fixtureMeeting('gemini-platform-sync.md', {
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
});
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

const rule = (which: string): AutomationRule => ({
  id: 'Meeting extraction',
  path: createVaultPath('.atlas/automations/Meeting extraction.md'),
  name: 'Meeting extraction',
  enabled: true,
  when: { kind: 'manual' },
  which,
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: MEETING_EXTRACTION_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-items' },
  },
});
const SYNC_ONLY = rule('FROM meeting WHERE provider = gemini');
const CALL_ONLY = rule('FROM meeting WHERE provider = granola');
const BOTH = rule('FROM meeting');

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
const FROM_CALL = says(
  item({ kind: 'task', title: 'Review the contract', owner: 'You', source_block: 't0003' }),
  item({ kind: 'waiting', title: 'Send the contract', owner: 'Lena Hart', source_block: 't0004' }),
  item({ kind: 'task', title: 'Go through the renewal', owner: 'Unknown', source_block: 't0002' }),
);

/** Who the vault's owner is, as their profile says: Mara, by name. */
const MARA_BY_NAME = { selfName: 'Mara Quill', selfEmails: [] };

function setUp(
  rounds: readonly ScriptedRound[],
  notes: Record<string, string> = NOTES,
  owner: { selfName: string | null; selfEmails: readonly string[] } = MARA_BY_NAME,
) {
  const claude = fakeClaudeStepPorts({
    rounds,
    model: 'claude-opus-5-5',
    today: TODAY,
    ...owner,
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

describe('meeting extraction over the Gemini fixture', () => {
  it('proposes a task of the owner’s, a waiting-for on a Person, a decision and a follow-up, each citing its turn', async () => {
    const { run, proposals } = setUp([FROM_SYNC]);

    const entry = await run(SYNC_ONLY);

    expect(entry).toMatchObject({ kind: 'run', done: [{}, {}, {}, {}] });
    const made = await proposals();
    expect([...made.keys()].sort()).toEqual([
      'Check Friday still works',
      'Flag the new cache',
      'Ship the cache behind a flag',
      'Write the rollout note',
    ]);
    const of = (title: string) => made.get(title)!.proposal;
    expect(of('Write the rollout note')).toMatchObject({
      kind: 'task',
      confidence: 'high',
      source: '[[Platform weekly sync#^t0003]]',
      payload: { properties: { status: 'inbox', due: '2026-10-02' } },
    });
    expect(of('Flag the new cache')).toMatchObject({
      kind: 'task',
      source: '[[Platform weekly sync#^t0002]]',
      payload: { properties: { status: 'waiting', waiting_on: '[[Tobias Fenn]]' } },
    });
    expect(of('Ship the cache behind a flag')).toMatchObject({
      kind: 'decision',
      payload: {
        properties: { meeting: '[[Platform weekly sync]]' },
        linkFrom: { property: 'decisions' },
      },
    });
    expect(of('Check Friday still works')).toMatchObject({
      kind: 'follow-up',
      confidence: 'medium',
      payload: {
        properties: { status: 'inbox', tags: ['follow-up'] },
        linkFrom: { property: 'tasks' },
      },
    });
    // Why each was proposed is what the card says under its headline.
    expect(made.get('Flag the new cache')!.reason).toBe(
      'Tobias Fenn took this on in Platform weekly sync, so it waits on them.',
    );
  });

  it('asks once, giving who was there, the provider’s next steps and the vocabulary as fenced data', async () => {
    const { run, asked } = setUp([FROM_SYNC]);

    await run(SYNC_ONLY);

    expect(asked()).toHaveLength(1);
    const told = asked()[0]!.system;
    expect(told).toContain('1. **Only real commitments.**');
    expect(told).toContain('{ "items": [ … ] }');
    expect(told).toContain(`<vault_data note="${SYNC}">`);
    expect(told).toContain(
      '<vault_data about="who was in each meeting">\nMeeting: Platform weekly sync',
    );
    expect(told).toContain('written “You” in the transcript: Mara Quill');
    expect(told).toContain(
      '- Mara Quill: the vault’s owner\n- Tobias Fenn\n- platform-team: a group address',
    );
    expect(told).toContain(
      '<vault_data about="the provider’s own next steps: hints, never a source">',
    );
    expect(told).toContain(
      '- Mara Quill: Draft the rollout note: write it for the platform channel.',
    );
    expect(told).toContain(
      '<vault_data about="the right spellings of names and terms">\nLarkspur Pay\n</vault_data>',
    );
  });

  it('knows the owner by the vault’s selfEmails alone, with no profile name and no Person note (#173)', async () => {
    const noOwnerNote = Object.fromEntries(
      Object.entries(NOTES).filter(([path]) => path !== 'People/Mara Quill.md'),
    );
    const byAddress = setUp([FROM_SYNC], noOwnerNote, {
      selfName: null,
      selfEmails: ['mara.quill@example.com'],
    });
    const byNeither = setUp([FROM_SYNC], noOwnerNote, { selfName: null, selfEmails: [] });

    await byAddress.run(SYNC_ONLY);
    await byNeither.run(SYNC_ONLY);

    expect(byAddress.asked()[0]!.system).toContain('- Mara Quill: the vault’s owner\n');
    expect((await byAddress.proposals()).get('Write the rollout note')!.proposal).toMatchObject({
      payload: { properties: { status: 'inbox' } },
    });
    expect(byNeither.asked()[0]!.system).not.toContain('the vault’s owner\n');
    expect((await byNeither.proposals()).get('Write the rollout note')!.proposal).toMatchObject({
      payload: { properties: { status: 'waiting', waiting_on: 'Mara Quill' } },
    });
  });

  it('accepting the owner’s task makes it in the Inbox, citing the turn and linked from the meeting', async () => {
    const { vault, run, proposals, properties } = setUp([FROM_SYNC]);
    await run(SYNC_ONLY);
    const made = await proposals();

    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: made.get('Write the rollout note')!.proposal.path,
      today: TODAY,
    });
    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: made.get('Flag the new cache')!.proposal.path,
      today: TODAY,
    });
    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: made.get('Ship the cache behind a flag')!.proposal.path,
      today: TODAY,
    });

    expect(properties('Tasks/2026/10/Write the rollout note.md')).toEqual({
      type: 'task',
      status: 'inbox',
      due: '2026-10-02',
      source: '[[Platform weekly sync#^t0003]]',
    });
    expect(properties('Tasks/2026/10/Flag the new cache.md')).toMatchObject({
      type: 'task',
      status: 'waiting',
      waiting_on: '[[Tobias Fenn]]',
    });
    expect(properties('Ship the cache behind a flag.md')).toMatchObject({
      type: 'decision',
      meeting: '[[Platform weekly sync]]',
      source: '[[Platform weekly sync#^t0003]]',
    });
    expect(properties(SYNC)['tasks']).toEqual([
      '[[Write the rollout note]]',
      '[[Flag the new cache]]',
    ]);
    expect(properties(SYNC)['decisions']).toEqual(['[[Ship the cache behind a flag]]']);
  });
});

describe('meeting extraction over the Granola fixture', () => {
  it('reads “You” as the owner, waits on a name with no Person note as text, and marks a guessed owner low', async () => {
    const { run, proposals } = setUp([FROM_CALL]);

    await run(CALL_ONLY);

    const made = await proposals();
    expect(made.get('Review the contract')!.proposal).toMatchObject({
      confidence: 'high',
      payload: { properties: { status: 'inbox' } },
    });
    // The turn it cites was spoken by "Remote Speaker": naming Lena is a guess, however sure the model was.
    expect(made.get('Send the contract')!).toMatchObject({
      proposal: {
        confidence: 'low',
        source: '[[Vendor contract call#^t0004]]',
        payload: { properties: { status: 'waiting', waiting_on: 'Lena Hart' } },
      },
      reason:
        'Lena Hart took this on in Vendor contract call, so it waits on them. There is no Person note for Lena Hart yet, so waiting_on holds the name as text. The turn it cites has no named speaker, so whose it is is a guess.',
    });
    expect(made.get('Go through the renewal')!).toMatchObject({
      proposal: { confidence: 'low', payload: { properties: { status: 'inbox', waiting_on: '' } } },
      reason: expect.stringContaining('Claude could not tell whose this is.'),
    });
  });

  it('accepting a waiting-for on a name alone is a task Waiting on that name', async () => {
    const { vault, run, proposals, properties } = setUp([FROM_CALL]);
    await run(CALL_ONLY);

    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: (await proposals()).get('Send the contract')!.proposal.path,
      today: TODAY,
    });

    expect(properties('Tasks/2026/10/Send the contract.md')).toMatchObject({
      status: 'waiting',
      waiting_on: 'Lena Hart',
    });
    expect(properties(CALL)['tasks']).toEqual(['[[Send the contract]]']);
  });
});

describe('an item that cites a turn the meeting does not have', () => {
  const WITH_INVENTED = says(
    item({ kind: 'task', title: 'Order the cake', owner: 'You', source_block: 't0099' }),
    item({
      kind: 'task',
      title: 'Flag the new cache',
      owner: 'Tobias Fenn',
      source_block: 't0002',
    }),
  );

  it('is dropped and logged, in the rule’s log and in Activity, and the rest are kept', async () => {
    const { run, proposals, log, activity } = setUp([WITH_INVENTED]);

    const entry = await run(SYNC_ONLY);

    expect([...(await proposals()).keys()]).toEqual(['Flag the new cache']);
    const dropped = [
      {
        title: 'Order the cake',
        reason: 'Platform weekly sync has no transcript turn ^t0099 that Claude was shown.',
      },
    ];
    expect(entry).toMatchObject({ kind: 'run', claude: { dropped } });
    expect(log()).toContain(
      '- dropped `"Order the cake"`: Platform weekly sync has no transcript turn ^t0099 that Claude was shown.',
    );
    expect(parseRunLog(log()).at(-1)).toMatchObject({ claude: { dropped } });
    expect(activity.reports.at(-1)?.message).toContain(
      'Made 1 proposal. Left out 1 item of the answer that did not read.',
    );
  });

  it('keeps the rest when one item has a bad kind, and says it was left out', async () => {
    const { run, proposals, log } = setUp([
      says(
        item({
          kind: 'task',
          title: 'Flag the new cache',
          owner: 'Tobias Fenn',
          source_block: 't0002',
        }),
        item({ kind: 'chore', title: 'Tidy', source_block: 't0001' }),
      ),
    ]);

    const entry = await run(SYNC_ONLY);

    expect(entry.kind).toBe('run');
    expect([...(await proposals()).keys()]).toEqual(['Flag the new cache']);
    expect(log()).toContain('- dropped `"Tidy"`: Its kind is not one of');
  });

  it('fails the run with nothing written when an item carries a key it was not asked for', async () => {
    const { run, proposals } = setUp([
      says(
        item({
          kind: 'task',
          title: 'Flag the new cache',
          owner: 'Tobias Fenn',
          source_block: 't0002',
        }),
        item({ kind: 'task', title: 'Tidy', source_block: 't0001', why: 'because' }),
      ),
    ]);

    const entry = await run(SYNC_ONLY);

    expect(entry).toMatchObject({
      kind: 'failed',
      problem: expect.stringContaining('Item 2: It has “why”'),
    });
    expect((await proposals()).size).toBe(0);
  });
});

describe('two meetings in one run', () => {
  it('asks about each alone, and each task links back to the meeting it was taken from', async () => {
    const sync = says(
      item({ kind: 'task', title: 'Write the rollout note', owner: 'You', source_block: 't0003' }),
    );
    const call = says(
      item({ kind: 'task', title: 'Review the contract', owner: 'You', source_block: 't0003' }),
    );
    const { vault, run, proposals, properties, asked, log } = setUp([sync, call]);

    await run(BOTH);

    expect(asked()).toHaveLength(2);
    expect(asked()[0]!.system).toContain(`<vault_data note="${SYNC}">`);
    expect(asked()[0]!.system).not.toContain('Vendor contract call');
    expect(asked()[1]!.system).toContain(`<vault_data note="${CALL}">`);
    expect(asked()[1]!.system).not.toContain('Platform weekly sync');
    expect(log()).toContain('- asked `2` times');
    const made = await proposals();
    for (const title of made.keys()) {
      await acceptProposalNote({
        via: 'app',
        ports: vault.ports,
        path: made.get(title)!.proposal.path,
        today: TODAY,
      });
    }
    expect(properties(SYNC)['tasks']).toEqual(['[[Write the rollout note]]']);
    expect(properties(CALL)['tasks']).toEqual(['[[Review the contract]]']);
  });

  it('drops an item that names the other meeting: no answer can file a task under a meeting it was not asked about', async () => {
    const crossed = says(
      item({
        kind: 'task',
        title: 'Review the contract',
        owner: 'You',
        source_block: '[[Vendor contract call#^t0003]]',
      }),
    );
    const { run, proposals, log } = setUp([crossed, says()]);

    await run(BOTH);

    expect((await proposals()).size).toBe(0);
    expect(log()).toContain(
      '- dropped `"Review the contract"`: It cites "Vendor contract call", which is not the meeting it was taken from.',
    );
  });
});

describe('a meeting too long for one ask', () => {
  /** The Gemini meeting with `turns` more turns of about 400 characters, ids from t0005. */
  const longMeeting = (turns: number, eol = '\n') => {
    let body = splitFrontmatter(GEMINI).body;
    for (let id = 5; id < 5 + turns; id += 1) {
      body += `\n**Tobias Fenn** [~00:10:00] Turn ${id}. ${'word '.repeat(75)}^t${String(id).padStart(4, '0')}\n`;
    }
    // The frontmatter keeps its own line endings: this vault's reader takes it as JSON lines.
    return `${GEMINI.slice(0, GEMINI.length - splitFrontmatter(GEMINI).body.length)}${body.replace(/\n/g, eol)}`;
  };
  const turnIn = (system: string, id: number) =>
    system.includes(`^t${String(id).padStart(4, '0')}`);

  it('is read in parts, each its own ask about whole turns under the meeting’s head, and every part’s items are kept', async () => {
    const long = longMeeting(105);
    expect(long.length).toBeGreaterThan(2 * CLAUDE_NOTE_CHARACTERS);
    const first = says(
      item({ kind: 'task', title: 'Write the rollout note', owner: 'You', source_block: 't0003' }),
    );
    const last = says(
      item({ kind: 'task', title: 'Close the loop', owner: 'Tobias Fenn', source_block: 't0109' }),
    );
    const { run, proposals, asked, log } = setUp([first, says(), last], { ...NOTES, [SYNC]: long });

    const entry = await run(SYNC_ONLY);

    expect(asked()).toHaveLength(3);
    for (const [at, request] of asked().entries()) {
      expect(request.system).toContain('## Provider next steps');
      expect(request.system).toContain(`(Part ${at + 1} of 3 of this transcript.`);
    }
    expect(turnIn(asked()[0]!.system, 3)).toBe(true);
    expect(turnIn(asked()[0]!.system, 109)).toBe(false);
    expect(turnIn(asked()[2]!.system, 109)).toBe(true);
    expect(turnIn(asked()[2]!.system, 3)).toBe(false);
    expect(entry).toMatchObject({ kind: 'run', claude: { asks: 3 } });
    expect(entry.kind === 'run' && entry.claude?.cut).toBeUndefined();
    expect(log()).toContain('- asked `3` times');
    expect([...(await proposals()).keys()].sort()).toEqual([
      'Close the loop',
      'Write the rollout note',
    ]);
  });

  it('reads a long meeting saved with Windows line endings in parts, and keeps what cites its turns', async () => {
    const last = says(
      item({ kind: 'task', title: 'Close the loop', owner: 'Tobias Fenn', source_block: 't0109' }),
    );
    const { run, proposals, asked } = setUp([says(), says(), last], {
      ...NOTES,
      [SYNC]: longMeeting(105, '\r\n'),
    });

    const entry = await run(SYNC_ONLY);

    expect(asked()).toHaveLength(3);
    expect(turnIn(asked()[2]!.system, 109)).toBe(true);
    expect(entry.kind === 'run' && entry.claude?.cut).toBeUndefined();
    expect((await proposals()).get('Close the loop')!.proposal).toMatchObject({
      source: '[[Platform weekly sync#^t0109]]',
      payload: { properties: { status: 'waiting', waiting_on: '[[Tobias Fenn]]' } },
    });
  });

  it('drops an item citing a turn of another part: only what an ask was shown can be cited in it', async () => {
    const early = says(
      item({ kind: 'task', title: 'Write the rollout note', owner: 'You', source_block: 't0003' }),
    );
    const { run, proposals, log } = setUp([says(), early, says()], {
      ...NOTES,
      [SYNC]: longMeeting(105),
    });

    await run(SYNC_ONLY);

    expect((await proposals()).size).toBe(0);
    expect(log()).toContain(
      '- dropped `"Write the rollout note"`: Platform weekly sync has no transcript turn ^t0003 that Claude was shown.',
    );
  });

  it('writes nothing when one part’s answer does not read, and says which', async () => {
    const good = says(
      item({ kind: 'task', title: 'Write the rollout note', owner: 'You', source_block: 't0003' }),
    );
    const { run, proposals } = setUp([good, [{ type: 'text', text: 'Sorry, no.' }]], {
      ...NOTES,
      [SYNC]: longMeeting(105),
    });

    const entry = await run(SYNC_ONLY);

    expect(entry).toMatchObject({
      kind: 'failed',
      problem: 'Claude’s answer is not what the rule asks for. Ask 2 of 3: It is not JSON.',
      claude: { asks: 2 },
    });
    expect((await proposals()).size).toBe(0);
  });

  it('stops at the most asks a run makes, and the log says how much of the meeting was read', async () => {
    const endless = longMeeting(700);
    const rounds = Array.from({ length: CLAUDE_ASKS_PER_RUN }, () => says());
    const { run, asked, log, activity } = setUp(rounds, { ...NOTES, [SYNC]: endless });

    const entry = await run(SYNC_ONLY);

    expect(asked()).toHaveLength(CLAUDE_ASKS_PER_RUN);
    expect(entry).toMatchObject({
      kind: 'run',
      claude: { asks: CLAUDE_ASKS_PER_RUN, cut: [{ path: SYNC, of: endless.length }] },
    });
    expect(log()).toMatch(
      /- cut `"Meetings\/Platform weekly sync.md"`: read `\d+` of `\d+` characters/,
    );
    expect(activity.reports.at(-1)?.message).toContain(
      '1 note was too long to read whole: Claude saw only the start.',
    );
  });
});
