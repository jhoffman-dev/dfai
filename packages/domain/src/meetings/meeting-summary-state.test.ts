import { describe, expect, it } from 'vitest';
import type { AutomationRule } from '../automations/automation-rule.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { placeSummary, renderSummaryBlock } from './meeting-summary-block.ts';
import {
  meetingSummaryState,
  writesSummaries,
  type SummaryStepFacts,
} from './meeting-summary-state.ts';

const PATH = createVaultPath('Meetings/2026/10/2026-10-14 Platform weekly sync.md');
const BODY =
  '\n## Summary\n\nShipped.\n\n## Transcript\n\n**Mara Quill** [00:00:01] Morning. ^t0001\n';
const IMPORTED = { atlas_import_outcome: 'imported', date: '2026-10-14' };
const STEP: SummaryStepFacts = { summarising: true, from: '2026-10-01', answered: false };

const BLOCK = renderSummaryBlock({
  model: 'claude-sonnet-5-5',
  date: '2026-10-14',
  summary: 'Larkspur Payroll agreed to ship the cache behind a flag.',
  keyPoints: [],
  decisions: [],
  actionItems: [],
  openQuestions: [],
}).text;

const state = (
  more: Partial<{
    path: typeof PATH;
    body: string;
    properties: Record<string, unknown>;
    step: SummaryStepFacts;
  }> = {},
) =>
  meetingSummaryState({
    path: PATH,
    body: BODY,
    properties: IMPORTED,
    step: STEP,
    ...more,
  });

describe('meetingSummaryState', () => {
  const placed = placeSummary(BODY, BLOCK, { recorded: null });
  if (!placed.ok) throw new Error('not placed');
  const recorded = { ...IMPORTED, atlas_summary_digest: placed.digest };

  it('is written while the block at the top is the one Claude wrote', () => {
    expect(state({ body: placed.body, properties: recorded })).toBe('written');
  });

  it('is written or edited whatever the rule does now', () => {
    const off = { ...STEP, summarising: false };
    expect(state({ body: placed.body, properties: recorded, step: off })).toBe('written');
    expect(
      state({ body: placed.body.replace('flag.', 'flag!'), properties: recorded, step: off }),
    ).toBe('edited');
  });

  it('is edited once the person changed the block, broke it or took it out', () => {
    expect(state({ body: placed.body.replace('flag.', 'flag!'), properties: recorded })).toBe(
      'edited',
    );
    expect(state({ body: BODY, properties: recorded })).toBe('edited');
    expect(state({ body: placed.body, properties: IMPORTED })).toBe('edited');
  });

  it('is pending for an imported meeting with turns the rule has yet to answer', () => {
    expect(state()).toBe('pending');
    // An undated one is not: the rule's `date >= …` never matches it (#637 review).
    expect(state({ properties: { atlas_import_outcome: 'imported' } })).toBe('none');
    // So is one dated on the first day the rule takes.
    expect(state({ properties: { ...IMPORTED, date: '2026-10-01' } })).toBe('pending');
  });

  it('is none when no enabled rule writes summaries', () => {
    expect(state({ step: { ...STEP, summarising: false } })).toBe('none');
  });

  it('is none once the rule answered it: nothing more is coming', () => {
    expect(state({ step: { ...STEP, answered: true } })).toBe('none');
  });

  it('is none for a meeting the import did not let in', () => {
    expect(state({ properties: { ...IMPORTED, atlas_import_outcome: 'duplicate' } })).toBe('none');
    expect(state({ properties: { ...IMPORTED, atlas_import_outcome: 'error' } })).toBe('none');
    expect(state({ properties: { date: '2026-10-14' } })).toBe('none');
  });

  it('is none for a meeting in the Archive', () => {
    expect(state({ path: createVaultPath('Archive/Meetings/2026-10-14 Sync.md') })).toBe('none');
  });

  it('is none for a meeting older than the rule reaches', () => {
    expect(state({ properties: { ...IMPORTED, date: '2026-09-30' } })).toBe('none');
  });

  it('is none for a meeting with no transcript turns to read', () => {
    expect(state({ body: '\n## Summary\n\nShipped.\n' })).toBe('none');
  });
});

describe('writesSummaries', () => {
  const rule = (action: AutomationRule['action'], enabled = true) => ({ enabled, action });
  const claude = (schema: string, apply?: 'mine') =>
    ({
      kind: 'claude',
      prompt: '.atlas/prompts/after-a-meeting.md',
      tools: [],
      output: { kind: 'proposals', schema },
      ...(apply !== undefined && { apply }),
    }) as const;

  it('is an enabled declared step whose answer is a meeting digest', () => {
    expect(writesSummaries(rule(claude('meeting-digest', 'mine')))).toBe(true);
  });

  it('counts a declared rule saved naming meeting-items, which the step reads as a digest', () => {
    expect(writesSummaries(rule(claude('meeting-items', 'mine')))).toBe(true);
  });

  it('is not a rule turned off, one without apply: mine, or one that is not a Claude step', () => {
    expect(writesSummaries(rule(claude('meeting-digest', 'mine'), false))).toBe(false);
    expect(writesSummaries(rule(claude('meeting-digest')))).toBe(false);
    expect(writesSummaries(rule({ kind: 'archive' }))).toBe(false);
    expect(
      writesSummaries(
        rule({
          kind: 'claude',
          prompt: '.atlas/prompts/x.md',
          tools: [],
          output: { kind: 'note', folder: 'Notes' },
        }),
      ),
    ).toBe(false);
  });
});
