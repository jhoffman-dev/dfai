/**
 * #182 (ADR-0036 "Failure modes"): Claude Code not installed or logged out on
 * the Mac that runs the declared step. A run a meeting set off fails with the
 * fix-it line, on record in the rule's log, and is raised so the runner backs
 * off and keeps the news; a run by hand settles with its entry as before. The
 * meeting stays pending until a retry answers it, and then clears.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  digestOf,
  parseObjectType,
  postProcessingFactsOf,
  postProcessingPending,
  splitFrontmatter,
  type AutomationRule,
  type ClaudeAction,
  type NoteChange,
} from '@dfai/domain';
import { ModelProviderError, type ModelEvent } from '../chat/ports.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { MEETING_BODY, MEETING_HEADER } from '../testing/meeting-files.ts';
import { readRuleLog } from './automation-log.ts';
import { ClaudeUnavailableError } from './claude-step.ts';
import { postProcessingKeyOf, postProcessingLedgerOf } from './post-processing-ledger.ts';
import { runAutomation, runOnNoteChanges } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };
const CHAT_MODEL = 'claude-opus-5-5';
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } }),
];

const meetingAt = (at: number): string => `Meetings/2026-10-${String(at).padStart(2, '0')} Sync.md`;
// Each meeting is one the import let in: in `Meetings`, a contract file is in play only then (#214).
const LET_IN = { ...MEETING_HEADER, atlas_import_outcome: 'imported' };
const meeting = (at: number) => jsonNote({ ...LET_IN, external_id: `gemini-${at}` }, MEETING_BODY);

const STEP: ClaudeAction = {
  kind: 'claude',
  prompt: AFTER_A_MEETING_PROMPT,
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-items' },
  apply: 'mine',
};
const RULE: AutomationRule = {
  id: 'After a meeting',
  path: createVaultPath('.atlas/automations/After a meeting.md'),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting',
  olderThanDays: null,
  action: STEP,
};

const NOTHING: ModelEvent[] = [{ type: 'text', text: JSON.stringify({ items: [] }) }];

const NOT_LOGGED_IN = {
  ready: false as const,
  problem: 'not_logged_in' as const,
  message: 'Claude Code is installed but not logged in.',
  fix: 'claude auth login',
};
const FIX_IT = 'Claude Code is installed but not logged in. Fix: claude auth login';
const MEETING = meetingAt(13);

type FakeClaude = NonNullable<Parameters<typeof fakeClaudeStepPorts>[0]>;

function setUp({
  rounds = [NOTHING],
  status = NOT_LOGGED_IN,
}: { rounds?: FakeClaude['rounds']; status?: FakeClaude['status'] } = {}) {
  const claude = fakeClaudeStepPorts({ rounds, model: CHAT_MODEL, today: TODAY, status });
  const notes: Record<string, string> = {
    [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
    [MEETING]: meeting(13),
  };
  const vault = automationVault({ notes, today: TODAY, types: TYPES, claude });
  const activity = recordingActivity();
  const run = { ports: vault.ports, rule: RULE, clock: CLOCK, guard: GUARD, activity };
  const arrived = () => {
    const change: NoteChange = {
      kind: 'added',
      path: MEETING,
      type: 'meeting',
      digest: digestOf(vault.files.get(MEETING) ?? ''),
    };
    return runOnNoteChanges({ ...run, changes: [change] });
  };
  /** Whether the meeting's summary and tasks are pending, as the count and the Inbox judge it. */
  const pending = async () => {
    const log = await readRuleLog(vault.ports.fs, RULE);
    const ledger = postProcessingLedgerOf(
      [{ rule: RULE, log: log.entries, ledger: log.ledger, idWritten: true }],
      () => TODAY,
    );
    const text = vault.files.get(MEETING)!;
    const { frontmatter, body } = splitFrontmatter(text);
    const properties = vault.ports.markdown.frontmatterProperties(frontmatter);
    const key = postProcessingKeyOf({ text, properties });
    return postProcessingPending({
      path: MEETING,
      importOutcome: 'imported',
      facts: postProcessingFactsOf({ body, properties, key }),
      ledger,
    });
  };
  const logIn = () => {
    claude.provider().status = async () => ({ ready: true });
  };
  return { claude, vault, activity, run, arrived, pending, logIn };
}

describe('the declared step when Claude Code cannot be reached (#182)', () => {
  it('fails a run a meeting set off with the fix-it line, raised for the runner, and asks nothing', async () => {
    const { arrived, claude, vault } = setUp();

    const raised = await arrived().catch((cause: unknown) => cause);

    expect(raised).toBeInstanceOf(ClaudeUnavailableError);
    expect((raised as ClaudeUnavailableError).entry).toMatchObject({
      kind: 'failed',
      problem: FIX_IT,
    });
    expect(claude.fake.requests).toEqual([]);
    const log = await readRuleLog(vault.ports.fs, RULE);
    expect(log.entries.at(-1)).toMatchObject({ kind: 'failed', problem: FIX_IT });
  });

  it('says the failure once in Activity, as its log entry says it', async () => {
    const { arrived, activity } = setUp();

    await arrived().catch(() => undefined);

    const lines = activity.reports.map(({ message }) => message);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(FIX_IT);
    expect(activity.reports[0]?.level).toBe('error');
  });

  it('settles a run by hand with its failed entry, as before', async () => {
    const { run } = setUp();

    const entry = await runAutomation({ ...run, trigger: 'hand' });

    expect(entry).toMatchObject({ kind: 'failed', problem: FIX_IT });
  });

  it('leaves the meeting pending, and clears it once a retry after logging in answers it', async () => {
    const { arrived, pending, logIn, claude } = setUp();
    await arrived().catch(() => undefined);
    expect(await pending()).toBe(true);

    logIn();
    const entry = await arrived();

    expect(entry?.kind).toBe('run');
    expect(claude.fake.requests).toHaveLength(1);
    expect(await pending()).toBe(false);
  });
});

describe('a provider that fails part-way through an ask (#637 review)', () => {
  it('raises a mid-ask "not logged in" as Claude out of reach', async () => {
    const { arrived } = setUp({
      status: { ready: true },
      rounds: [
        new ModelProviderError('not_logged_in', 'Claude Code is installed but not logged in.'),
      ],
    });

    const raised = await arrived().catch((cause: unknown) => cause);

    expect(raised).toBeInstanceOf(ClaudeUnavailableError);
  });

  it('settles a timeout or an API failure as a failed run, raising nothing', async () => {
    const { arrived } = setUp({
      status: { ready: true },
      rounds: [new ModelProviderError('failed', 'Claude did not finish within 10 minutes.')],
    });

    const entry = await arrived();

    expect(entry).toMatchObject({
      kind: 'failed',
      problem: 'Claude did not finish within 10 minutes.',
    });
  });
});
