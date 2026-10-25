/**
 * Adversarial pass on PR #553 (#19), over the same in-memory vault, import,
 * linker and scripted model as claude-step.term-suggestions.test.ts. A term
 * proposal waits in the Inbox while the vault moves on; accepting it must not
 * break what the vault has since, and a rejection must answer for that one
 * term, not for another the key happens to fold onto it.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  resolveWikiLinkTarget,
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

async function setUp(rounds: readonly ScriptedRound[], extra: Record<string, string> = {}) {
  const claude = fakeClaudeStepPorts({ rounds, model: 'claude-sonnet-5-5', today: TODAY });
  const vault = automationVault({
    notes: { ...DIRECTORY, ...extra },
    today: TODAY,
    types: TYPES,
    claude,
  });
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

const PROPOSAL = createVaultPath('Inbox/Proposals/Brenwick.md');

describe('a suggested term accepted after the vault moved on', () => {
  it('does not stop a term added meanwhile from putting its heard words right', async () => {
    const { vault, arrive } = await setUp([BRENWICK, says()]);
    await arrive('Contracts');
    // While the card waits, James adds the company by hand, misheard the same way.
    await vault.ports.fs.createNote({
      path: createVaultPath('Terms/Brenwick Labs.md'),
      contents: jsonNote({ type: 'term', kind: 'company', variants: ['Bren Wick'] }, ''),
    });

    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: PROPOSAL,
      today: TODAY,
    }).catch(
      // A refusal is an acceptable answer here: what matters is the next meeting.
      (cause: unknown) => cause,
    );
    const next = await arrive('Renewal', 'The Bren Wick renewal is due.');

    expect(vault.files.get(next)!).not.toContain('The Bren Wick renewal');
  });

  it('never takes over the wiki links of a note of the same name elsewhere', async () => {
    const elsewhere = 'Clients/Northwind/Brenwick.md';
    const { vault, arrive } = await setUp([BRENWICK], {
      [elsewhere]: jsonNote({ type: 'project' }, 'The Brenwick account.'),
    });
    await arrive('Contracts');
    const notes = () => [...vault.files.keys()].map((at) => createVaultPath(at));
    expect(resolveWikiLinkTarget('Brenwick', notes())).toBe(elsewhere);

    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: PROPOSAL,
      today: TODAY,
    }).catch((cause: unknown) => cause);

    // The Terms page refuses this (`linkTakeover`); every [[Brenwick]] would open the new term.
    expect(resolveWikiLinkTarget('Brenwick', notes())).toBe(elsewhere);
  });
});

describe('a rejected suggested term', () => {
  it('does not refuse another name its key folds onto: rejecting Luca leaves Lucas', async () => {
    const { vault, arrive, termProposals } = await setUp([
      says(term('Luca', 'Lukah')),
      says(term('Lucas', 'Lookas')),
    ]);
    await arrive('Hiring', 'Ask Lukah about the offer.');
    expect(termProposals()).toEqual(['Inbox/Proposals/Luca.md']);
    await rejectProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath('Inbox/Proposals/Luca.md'),
      today: TODAY,
    });

    await arrive('Hiring again', 'Ask Lookas about the offer.');

    expect(termProposals().filter((at) => at.startsWith('Inbox/'))).toEqual([
      'Inbox/Proposals/Lucas.md',
    ]);
  });
});
