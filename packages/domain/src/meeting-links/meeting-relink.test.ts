import { describe, expect, it } from 'vitest';
import { describePlan, type AutomationPlan } from '../automations/automation-plan.ts';
import type { AutomationAction } from '../automations/automation-rule.ts';
import { dryRunReport } from '../activity/activity-reports.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  describeNotLinked,
  LINKING_FAILED,
  linkingFailed,
  linkingFailedStamp,
  MEETING_LINKS_KEY,
  meetingsToRelink,
  RELINKS_PER_RUN,
  relinkSettled,
  relinksMeetings,
} from './meeting-relink.ts';

const p = createVaultPath;
const MEETING = p('Inbox/Meetings/2026-10-06 Standup.md');
const DECLARED: AutomationAction = {
  kind: 'claude',
  prompt: '.atlas/prompts/after-a-meeting.md',
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-digest' },
  apply: 'mine',
};

describe('the mark of linking that failed', () => {
  it('is what the stamp write adds, and what is read back as failed', () => {
    expect(linkingFailedStamp()).toEqual({ atlas_links: 'failed' });
    expect(linkingFailed(linkingFailedStamp())).toBe(true);
  });

  it.each([
    ['a list, by its first item', ['failed'], true],
    ['with spaces round it', '  failed ', true],
    ['absent', undefined, false],
    ['an empty list', [], false],
    ['another word', 'done', false],
    ['a list whose first item is another word', ['done', 'failed'], false],
    ['not text', 1, false],
    ['null', null, false],
  ])('reads %s', (_, value, failed) => {
    const properties = value === undefined ? {} : { [MEETING_LINKS_KEY]: value };
    expect(linkingFailed(properties)).toBe(failed);
  });

  it('is DFAI’s own key', () => {
    expect(MEETING_LINKS_KEY).toBe('atlas_links');
    expect(LINKING_FAILED).toBe('failed');
  });
});

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

describe('meetingsToRelink', () => {
  const failed = (path: string) => ({ path: p(path), properties: linkingFailedStamp() });
  const linked = (path: string) => ({ path: p(path), properties: { people: ['[[Mara Quill]]'] } });

  it('is none when every meeting is linked', () => {
    expect(meetingsToRelink([linked('A.md'), linked('B.md')])).toBeNull();
    expect(meetingsToRelink([])).toBeNull();
  });

  it('takes only those whose linking failed, in the order given, each once', () => {
    const notes = [failed('B.md'), linked('A.md'), failed('C.md'), failed('B.md')];
    expect(meetingsToRelink(notes)).toEqual({ paths: ['B.md', 'C.md'], capped: false });
  });

  it('stops at the cap, and says more wait', () => {
    const notes = ['A.md', 'B.md', 'C.md'].map(failed);
    expect(meetingsToRelink(notes, 2)).toEqual({ paths: ['A.md', 'B.md'], capped: true });
    expect(meetingsToRelink(notes, 3)).toEqual({ paths: ['A.md', 'B.md', 'C.md'], capped: false });
  });

  it('caps at fifty by default', () => {
    const notes = Array.from({ length: RELINKS_PER_RUN + 1 }, (_, at) => failed(`M${at}.md`));
    const found = meetingsToRelink(notes);
    expect(RELINKS_PER_RUN).toBe(50);
    expect(found?.paths).toHaveLength(RELINKS_PER_RUN);
    expect(found?.capped).toBe(true);
  });
});

describe('relinkSettled', () => {
  it('is settled when linking left nothing of the meeting’s own', () => {
    expect(relinkSettled({ meeting: MEETING, left: [] })).toBe(true);
  });

  it('is settled when only a proposal was left: the links stand', () => {
    const proposal = p('Inbox/Proposals/Mara Quill.md');
    expect(relinkSettled({ meeting: MEETING, left: [{ path: proposal }] })).toBe(true);
  });

  it('is not settled when the meeting itself was left', () => {
    expect(relinkSettled({ meeting: MEETING, left: [{ path: MEETING }] })).toBe(false);
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
