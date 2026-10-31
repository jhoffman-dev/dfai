import { describe, expect, it } from 'vitest';
import { dryRunReport } from '../activity/activity-reports.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { describePlan, type AutomationPlan } from './automation-plan.ts';
import type { AutomationAction } from './automation-rule.ts';
import { describeNotLinked, relinksMeetings } from './relink-plan.ts';

const p = createVaultPath;
const MEETING = p('Inbox/Meetings/2026-10-06 Standup.md');
const DECLARED: AutomationAction = {
  kind: 'claude',
  prompt: '.atlas/prompts/after-a-meeting.md',
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-digest' },
  apply: 'mine',
};

describe('relinksMeetings', () => {
  it('is the declared step, which says apply: mine', () => {
    expect(relinksMeetings({ action: DECLARED })).toBe(true);
  });

  it('is no other rule', () => {
    const proposalsOnly: AutomationAction = {
      kind: 'claude',
      prompt: '.atlas/prompts/after-a-meeting.md',
      tools: [],
      output: { kind: 'proposals', schema: 'meeting-digest' },
    };
    expect(relinksMeetings({ action: proposalsOnly })).toBe(false);
    expect(relinksMeetings({ action: { kind: 'archive' } })).toBe(false);
    expect(relinksMeetings({ action: { kind: 'set', values: { status: 'done' } } })).toBe(false);
  });
});

describe('what a dry run says of meetings not linked', () => {
  const plan = (paths: string[]): AutomationPlan => ({
    action: DECLARED,
    paths: paths.map(p),
    passedOver: [],
    capped: false,
  });
  const one = { paths: [MEETING], capped: false };

  it('counts them, one or many, and says when more wait', () => {
    expect(describeNotLinked(one)).toBe('1 meeting is not linked: Run now links it first.');
    expect(describeNotLinked({ paths: [MEETING, p('B.md')], capped: false })).toBe(
      '2 meetings are not linked: Run now links them first.',
    );
    expect(describeNotLinked({ paths: [MEETING], capped: true })).toBe(
      '1 meeting is not linked: Run now links it first. More wait for the next run.',
    );
  });

  it('says them instead of "nothing to do" when nothing else would be done', () => {
    expect(describePlan(plan([]))).toBe('Nothing to do right now.');
    expect(describePlan({ ...plan([]), notLinked: one })).toBe(
      '1 meeting is not linked: Run now links it first.',
    );
  });

  it('says them after what else the run would do', () => {
    expect(describePlan({ ...plan(['A.md']), notLinked: one })).toBe(
      'Would ask Claude about 1 note. 1 meeting is not linked: Run now links it first.',
    );
  });

  it('says them in the dry run’s Activity line', () => {
    const named = { name: 'After a meeting', path: null };
    expect(dryRunReport(named, { plan: { ...plan([]), notLinked: one } }).message).toBe(
      'After a meeting: Dry run. Nothing to do. 1 meeting is not linked: Run now links it first.',
    );
    expect(dryRunReport(named, { plan: plan([]) }).message).toBe(
      'After a meeting: Dry run. Nothing to do.',
    );
  });
});
