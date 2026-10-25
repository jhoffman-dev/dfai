/**
 * #19: the "After a meeting" step suggests glossary terms. Over the meeting
 * import, its links and the rule — a vault held in memory whose index
 * answers with real SQL, and a scripted model in place of Claude — a term
 * the model suggests is a proposal, everyday words and what the glossary has
 * are left out and logged, a term is proposed once however many meetings
 * mishear it, and accepting it puts the next meeting's words right. A failed
 * ask leaves the import's corrections and links where they are.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  logPathFor,
  MEETING_DIGEST_OUTPUT,
  noteChangesBetween,
  parseObjectType,
  parseRunLog,
  splitFrontmatter,
  versionsAfter,
  type AutomationRule,
  type NoteChange,
  type NoteVersion,
  type VaultPath,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { heldEntries } from '../index/refresh-index.ts';
import { createMeetingLinker } from '../meeting-links/link-imported-meetings.ts';
import { createMeetingImporter } from '../meetings/meeting-importer.ts';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
import { rejectProposalNote } from '../proposals/reject-proposal.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import type { ScriptedRound } from '../testing/fake-model.ts';
import { MEETING_HEADER } from '../testing/meeting-files.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { runOnNoteChanges } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-08';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };
const relation = (target: string) => ({ kind: 'relation', target, many: true });
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({
    name: 'meeting',
    label: 'Meeting',
    properties: { tasks: relation('task'), decisions: relation('decision') },
  }),
  parseObjectType({ name: 'term', label: 'Term', properties: {} }),
];

/** Mara Quill is a person; "Lark Spur Pay" is a product the vocabulary already puts right. */
const DIRECTORY = {
  'People/Mara Quill.md': jsonNote({ type: 'person' }, ''),
  'Terms/Larkspur Pay.md': jsonNote(
    { type: 'term', kind: 'product', variants: ['Lark Spur Pay'] },
    '',
  ),
  [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
};

/** A meeting whose transcript mishears Brenwick as "Bren Wick", beside a product the vocabulary knows. */
const body = (said = 'Send the Bren Wick contract and the Lark Spur Pay file.') =>
  [
    '',
    '## Summary',
    '',
    'Contracts before the go-live. ^s1',
    '',
    '## Transcript',
    '',
    `**Mara Quill** [~00:00:00] ${said} ^t0001`,
    '',
    '**Mara Quill** [~00:00:09] And book the review. ^t0002',
    '',
  ].join('\n');

const RULE: AutomationRule = {
  id: 'After a meeting',
  path: createVaultPath('.atlas/automations/After a meeting.md'),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: MEETING_DIGEST_OUTPUT },
    apply: 'mine',
  },
};

const term = (title: string, heard: string, block = 't0001') => ({
  kind: 'term',
  title,
  heard,
  owner: '',
  source_block: block,
  confidence: 'medium',
});
const says = (...items: unknown[]): ModelEvent[] => [
  {
    type: 'text',
    text: JSON.stringify({
      summary: 'Mara asked for the contracts.',
      key_points: [],
      open_questions: [],
      items,
    }),
  },
];
const BRENWICK = says(term('Brenwick', 'Bren Wick'));

async function setUp(rounds: readonly ScriptedRound[]) {
  const claude = fakeClaudeStepPorts({ rounds, model: 'claude-sonnet-5-5', today: TODAY });
  const vault = automationVault({ notes: { ...DIRECTORY }, today: TODAY, types: TYPES, claude });
  const activity = recordingActivity();
  const wiring = {
    ports: () => vault.ports,
    clock: CLOCK,
    activity,
    openVault: () => VAULT,
    onWritten: () => undefined,
  };
  const linker = createMeetingLinker({ ...wiring, selfName: () => null, selfEmails: () => [] });
  const importer = createMeetingImporter({
    ...wiring,
    active: () => true,
    beforeLetIn: async (vaultKey: string, path: VaultPath) => void (await linker(vaultKey, [path])),
  });

  let held = new Map<string, NoteVersion>(await heldEntries(vault.ports.index));
  const sync = async (): Promise<NoteChange[]> => {
    const changes = noteChangesBetween(held, await heldEntries(vault.ports.index));
    held = versionsAfter(held, changes);
    return changes;
  };
  /** A meeting file lands, the import lets it in, and the rule hears every change that made. */
  const arrive = async (title: string, said?: string) => {
    const path = `Inbox/Meetings/${TODAY} ${title}.md`;
    const header = { ...MEETING_HEADER, title, date: TODAY, external_id: `gemini-${title}` };
    await vault.ports.fs.createNote({
      path: createVaultPath(path),
      contents: jsonNote(header, body(said)),
    });
    await importer.hear({ vault: VAULT, changes: await sync() });
    const changes = await sync();
    await runOnNoteChanges({
      ports: vault.ports,
      rule: RULE,
      clock: CLOCK,
      guard: GUARD,
      activity,
      changes,
    });
    return path;
  };
  const propertiesOf = (text: string) =>
    vault.ports.markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
  const termProposals = () =>
    [...vault.files]
      .filter(([at, text]) => at.includes('Proposals/') && propertiesOf(text)['kind'] === 'term')
      .map(([at]) => at)
      .sort();
  const log = () => parseRunLog(vault.files.get(logPathFor(RULE.id)) ?? '');
  return { vault, arrive, termProposals, propertiesOf, log, asked: () => claude.fake.requests };
}

describe('a term the "After a meeting" step suggests', () => {
  it('is a proposal citing its turn, misheard as the transcript has it', async () => {
    const { vault, arrive, termProposals, propertiesOf } = await setUp([BRENWICK]);
    await arrive('Contracts');

    expect(termProposals()).toEqual(['Inbox/Proposals/Brenwick.md']);
    const proposal = vault.files.get('Inbox/Proposals/Brenwick.md')!;
    expect(propertiesOf(proposal)).toMatchObject({
      kind: 'term',
      state: 'open',
      source: `[[${TODAY} Contracts#^t0001]]`,
      payload: { title: 'Brenwick', folder: 'Terms', properties: { variants: ['Bren Wick'] } },
    });
    expect(splitFrontmatter(proposal).body).toContain('Heard as “Bren Wick”');
  });

  it('leaves out everyday words and what the glossary has, and the log says why', async () => {
    const { arrive, termProposals, log } = await setUp([
      says(
        term('Brenwick', 'Bren Wick'),
        term('Sendthe', 'Send the'),
        term('Larkspur Pay', 'Lark Spur Pay'),
      ),
    ]);
    await arrive('Contracts');

    expect(termProposals()).toEqual(['Inbox/Proposals/Brenwick.md']);
    const text = JSON.stringify(log());
    expect(text).toContain('“Send the” is everyday words');
    expect(text).toContain('“Larkspur Pay” is already in the glossary');
  });

  it('is proposed once, however many meetings mishear it, and never again once rejected', async () => {
    const { vault, arrive, termProposals, asked } = await setUp([BRENWICK, BRENWICK, BRENWICK]);
    await arrive('Contracts');
    await arrive('Contracts again');
    expect(asked()).toHaveLength(2);
    expect(termProposals()).toEqual(['Inbox/Proposals/Brenwick.md']);

    await rejectProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath('Inbox/Proposals/Brenwick.md'),
      today: TODAY,
    });
    await arrive('Contracts once more');

    expect(asked()).toHaveLength(3);
    expect(termProposals().filter((at) => at.startsWith('Inbox/'))).toEqual([]);
  });

  it('accepted, is a term, and the next meeting arrives with its words put right', async () => {
    const { vault, arrive, propertiesOf } = await setUp([BRENWICK, says()]);
    await arrive('Contracts');
    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath('Inbox/Proposals/Brenwick.md'),
      today: TODAY,
    });
    expect(propertiesOf(vault.files.get('Terms/Brenwick.md')!)).toMatchObject({
      type: 'term',
      variants: ['Bren Wick'],
    });

    const next = await arrive('Renewal', 'The Bren Wick renewal is due.');

    const arrived = vault.files.get(next)!;
    expect(arrived).toContain('The Brenwick renewal is due. ^t0001');
    expect(arrived).not.toContain('Bren Wick renewal');
  });
});

describe('a term waiting in the Inbox when the next meeting suggests it', () => {
  it('heard another way, is not proposed again, and the log says to add the spelling later', async () => {
    const { arrive, termProposals, log } = await setUp([
      BRENWICK,
      says(term('Brenwick', 'Bren Wik')),
    ]);
    await arrive('Contracts');
    await arrive('Renewal', 'The Bren Wik renewal is due.');

    expect(termProposals()).toEqual(['Inbox/Proposals/Brenwick.md']);
    expect(JSON.stringify(log())).toContain(
      '“Brenwick” is proposed already, waiting in the Inbox; once it is a term, add “Bren Wik” to its misheard spellings on the Terms page.',
    );
  });

  it('heard the same way for another name, is blocked, and the log says by which', async () => {
    const { arrive, termProposals, log } = await setUp([
      BRENWICK,
      says(term('Brenwyck', 'Bren Wick')),
    ]);
    await arrive('Contracts');
    await arrive('Renewal', 'The Bren Wick renewal is due.');

    expect(termProposals()).toEqual(['Inbox/Proposals/Brenwick.md']);
    expect(JSON.stringify(log())).toContain(
      '“Bren Wick” is proposed already, as “Brenwick”, waiting in the Inbox.',
    );
  });
});

describe('accepting a term once the vault has moved on', () => {
  it('is refused, saying why, when what it was heard as is another term’s now; the card stays open', async () => {
    const { vault, arrive, propertiesOf } = await setUp([BRENWICK]);
    await arrive('Contracts');
    await vault.ports.fs.createNote({
      path: createVaultPath('Terms/Brenwick Labs.md'),
      contents: jsonNote({ type: 'term', variants: ['Bren Wick'] }, ''),
    });

    await expect(
      acceptProposalNote({
        via: 'app',
        ports: vault.ports,
        path: createVaultPath('Inbox/Proposals/Brenwick.md'),
        today: TODAY,
      }),
    ).rejects.toThrow(
      '“Bren Wick” is now a misheard spelling of “Brenwick Labs”; accepted, neither would be put right.',
    );
    expect(vault.files.has('Terms/Brenwick.md')).toBe(false);
    expect(propertiesOf(vault.files.get('Inbox/Proposals/Brenwick.md')!)).toMatchObject({
      state: 'open',
    });
  });

  it('is refused when a note of its name elsewhere would lose its links to it', async () => {
    const { vault, arrive } = await setUp([BRENWICK]);
    await vault.ports.fs.createNote({
      path: createVaultPath('Clients/Northwind/Brenwick.md'),
      contents: jsonNote({ type: 'project' }, ''),
    });
    await arrive('Contracts');

    await expect(
      acceptProposalNote({
        via: 'app',
        ports: vault.ports,
        path: createVaultPath('Inbox/Proposals/Brenwick.md'),
        today: TODAY,
      }),
    ).rejects.toThrow(
      '[[Brenwick]] already opens Clients/Northwind/Brenwick.md, and would open the new term instead. Rename one of them first.',
    );
  });
});

describe('what a run reads of the proposals folder', () => {
  it('reads it once, for the terms waiting there and for what it will not propose twice', async () => {
    const { vault, arrive, termProposals } = await setUp([
      BRENWICK,
      says(term('Brenwick', 'Bren Wik'), term('Quillworth', 'Quill Worth')),
    ]);
    await arrive('Contracts');
    const list = vault.ports.fs.listDirectory;
    const read = vault.ports.fs.readNotes;
    let listed = 0;
    let readBack = 0;
    vault.ports.fs.listDirectory = async (folder) => {
      if (folder === 'Inbox/Proposals') listed += 1;
      return list(folder);
    };
    vault.ports.fs.readNotes = async (paths) => {
      if (paths.some((at) => at.startsWith('Inbox/Proposals/'))) readBack += 1;
      return read(paths);
    };

    await arrive('Renewal', 'The Bren Wik renewal is due, and Quill Worth signs it.');

    expect(termProposals()).toEqual([
      'Inbox/Proposals/Brenwick.md',
      'Inbox/Proposals/Quillworth.md',
    ]);
    expect({ listed, readBack }).toEqual({ listed: 1, readBack: 1 });
  });
});

describe('two runs writing the same term at once', () => {
  it('makes it once: the second finds it made at its path, and does not fail', async () => {
    const { vault, arrive, termProposals, log } = await setUp([BRENWICK]);
    const create = vault.ports.fs.createNote;
    // Another rule's run writes the very proposal between this run's plan and its write.
    vault.ports.fs.createNote = async (note) => {
      if (note.path.startsWith('Inbox/Proposals/')) {
        await create(note);
        throw new VaultAccessError('something with that name is already there');
      }
      return create(note);
    };
    await arrive('Contracts');

    expect(termProposals()).toEqual(['Inbox/Proposals/Brenwick.md']);
    expect(log().at(-1)).toMatchObject({ kind: 'run' });
  });
});

describe('a failed ask after a meeting arrives', () => {
  it('leaves the import’s corrections and links in place, and logs the failure', async () => {
    const { vault, arrive, termProposals, propertiesOf, log } = await setUp([
      new Error('Claude is not signed in'),
    ]);
    await expect(arrive('Contracts')).rejects.toThrow('Claude is not signed in');

    const meeting = vault.files.get(`Inbox/Meetings/${TODAY} Contracts.md`)!;
    expect(meeting).toContain('Send the Bren Wick contract and the Larkspur Pay file. ^t0001');
    expect(propertiesOf(meeting)).toMatchObject({
      people: ['[[Mara Quill]]'],
      atlas_corrections: [{ from: 'Lark Spur Pay', to: 'Larkspur Pay' }],
    });
    expect(termProposals()).toEqual([]);
    expect(log().at(-1)).toMatchObject({
      kind: 'failed',
      problem: expect.stringContaining('Claude is not signed in'),
    });
  });
});

/** Verification of PR #553 (#19): gaps the fix round left. Each test is one invariant. */
describe('verify #553: accepting a term once the vault has moved on', () => {
  it('is refused when what it was heard as is now what a person goes by (an alias)', async () => {
    const { vault, arrive, propertiesOf } = await setUp([BRENWICK]);
    await arrive('Contracts');
    await vault.ports.fs.createNote({
      path: createVaultPath('People/Brenda Wick.md'),
      contents: jsonNote({ type: 'person', aliases: ['Bren Wick'] }, ''),
    });

    await expect(
      acceptProposalNote({
        via: 'app',
        ports: vault.ports,
        path: createVaultPath('Inbox/Proposals/Brenwick.md'),
        today: TODAY,
      }),
    ).rejects.toThrow('Bren Wick');
    expect(vault.files.has('Terms/Brenwick.md')).toBe(false);
    expect(propertiesOf(vault.files.get('Inbox/Proposals/Brenwick.md')!)).toMatchObject({
      state: 'open',
    });
  });
});

describe('verify #553: one answer naming one term heard two ways', () => {
  it('logs the second heard spelling rather than dropping it without a word', async () => {
    const { arrive, termProposals, log } = await setUp([
      says(term('Brenwick', 'Bren Wick'), term('Brenwick', 'Bren Wik')),
    ]);
    await arrive('Contracts', 'Send the Bren Wick contract, the Bren Wik one too.');

    expect(termProposals()).toEqual(['Inbox/Proposals/Brenwick.md']);
    expect(JSON.stringify(log())).toContain('Bren Wik');
  });
});

describe('verify #553: a raced proposal write whose read-back fails', () => {
  it('fails the run saying the write failed, not with the read-back’s own error', async () => {
    const { vault, arrive, log } = await setUp([BRENWICK]);
    const create = vault.ports.fs.createNote;
    const read = vault.ports.fs.readNotes;
    let createFailed = false;
    vault.ports.fs.createNote = async (note) => {
      if (note.path.startsWith('Inbox/Proposals/')) {
        createFailed = true;
        throw new VaultAccessError('something with that name is already there');
      }
      return create(note);
    };
    vault.ports.fs.readNotes = async (paths) => {
      const readingBack = paths.some((at) => at.startsWith('Inbox/Proposals/'));
      if (createFailed && readingBack) throw new VaultAccessError('permission denied');
      return read(paths);
    };

    await arrive('Contracts').catch(() => undefined);

    expect(log().at(-1)).toMatchObject({
      kind: 'failed',
      problem: expect.stringContaining('then the write failed'),
    });
  });
});
