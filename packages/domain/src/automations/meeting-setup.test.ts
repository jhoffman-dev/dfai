import { describe, expect, it } from 'vitest';
import { MEETING_IMPORT_PROPERTIES } from '../meetings/meeting-import-properties.ts';
import { MEETING_SUMMARY_PROPERTIES } from '../meetings/meeting-summary-block.ts';
import type { SelfEmails } from '../profile/self-emails.ts';
import { parseObjectType, type ObjectType } from '../types/property-def.ts';
import type { AutomationDraft } from './automation-rule.ts';
import {
  meetingSetupComplete,
  meetingSetupPlan,
  meetingSetupWithin,
  postProcessesMeetings,
  type MeetingSetupFacts,
} from './meeting-setup.ts';
import { AFTER_A_MEETING_PRESET, AUTOMATION_PRESETS } from './presets.ts';

const type = (frontmatter: Record<string, unknown>): ObjectType => parseObjectType(frontmatter);
const keys = (properties: readonly { key: string }[] | undefined) =>
  (properties ?? []).map((property) => property.key);

const NO_EMAILS: SelfEmails = { emails: [], source: null, problem: null };
const MEETING = type({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } });
const TASK = type({ name: 'task', label: 'Task', properties: { status: 'text' } });
const PROMPT = '.atlas/prompts/after-a-meeting.md';

const facts = (over: Partial<MeetingSetupFacts> = {}): MeetingSetupFacts => ({
  types: [MEETING, TASK],
  rules: [],
  takenPaths: [],
  promptHeld: false,
  selfEmails: NO_EMAILS,
  ...over,
});

const MEETING_KEYS = [
  ...keys(MEETING_IMPORT_PROPERTIES),
  'tasks',
  'decisions',
  ...keys(MEETING_SUMMARY_PROPERTIES),
];

describe('meetingSetupPlan', () => {
  it('in a vault with nothing set up, offers the rule, its prompt, both types’ keys and the emails', () => {
    const plan = meetingSetupPlan(facts());
    expect(plan.rule).toBe(AFTER_A_MEETING_PRESET);
    expect(plan.prompt).toBe(PROMPT);
    const [meeting, task] = plan.extensions;
    expect(meeting?.before).toBe(MEETING);
    expect(keys(meeting?.added)).toEqual(MEETING_KEYS);
    expect(keys(meeting?.after.properties)).toEqual(['date', ...MEETING_KEYS]);
    expect(task?.before).toBe(TASK);
    expect(keys(task?.added)).toEqual(['meeting', 'atlas_item']);
    expect(plan.asksEmails).toBe(true);
    expect(plan.lines.map((line) => line.written)).toEqual([true, true, true, true, true]);
    expect(meetingSetupComplete(plan)).toBe(false);
  });

  it('lists the rule as its file will say it: prompt, output, apply and the 14-day which', () => {
    const [rule] = meetingSetupPlan(facts()).lines;
    expect(rule?.what).toBe('The “After a meeting” rule');
    expect(rule?.detail).toContain(`prompt: ${PROMPT}`);
    expect(rule?.detail).toContain('output: meeting-digest');
    expect(rule?.detail).toContain('apply: mine');
    expect(rule?.detail).toContain('which: FROM meeting WHERE date >= @-14d');
  });

  it('writes the rule the presets offer, so the two never differ', () => {
    expect(AUTOMATION_PRESETS).toContain(AFTER_A_MEETING_PRESET);
    expect(AFTER_A_MEETING_PRESET.action).toMatchObject({
      kind: 'claude',
      prompt: PROMPT,
      output: { kind: 'proposals', schema: 'meeting-digest' },
      apply: 'mine',
    });
  });

  it('says the emails field matters: without it, matching is by name only', () => {
    const emails = meetingSetupPlan(facts()).lines.at(-1);
    expect(emails?.what).toBe('Your email addresses');
    expect(emails?.kind).toBe('emails');
    expect(meetingSetupPlan(facts()).lines.map((line) => line.kind)).toEqual([
      'rule',
      'prompt',
      'type',
      'type',
      'emails',
    ]);
    expect(emails?.detail).toContain('selfEmails');
    expect(emails?.detail).toContain('by your name only');
  });

  it('skips a rule already there under any name, and says when it is off', () => {
    const own: AutomationDraft = { ...AFTER_A_MEETING_PRESET, name: 'Digest my meetings' };
    const on = meetingSetupPlan(facts({ rules: [own] }));
    expect(on.rule).toBeNull();
    expect(on.lines[0]).toMatchObject({ written: false });
    expect(on.lines[0]?.detail).toBe('Already there, as “Digest my meetings”.');
    const off = meetingSetupPlan(facts({ rules: [{ ...own, enabled: false }] }));
    expect(off.rule).toBeNull();
    expect(off.lines[0]?.detail).toContain('It is turned off');
  });

  it('counts a rule saved before the digest, meeting-items with apply: mine, as set up', () => {
    const older: AutomationDraft = {
      ...AFTER_A_MEETING_PRESET,
      action: {
        kind: 'claude',
        prompt: PROMPT,
        tools: [],
        output: { kind: 'proposals', schema: 'meeting-items' },
        apply: 'mine',
      },
    };
    expect(postProcessesMeetings(older)).toBe(true);
    expect(meetingSetupPlan(facts({ rules: [older] })).rule).toBeNull();
  });

  it('does not count the older extraction preset, which proposes but makes no tasks', () => {
    const extraction = AUTOMATION_PRESETS.find((preset) => preset.name.startsWith('Pull'));
    expect(extraction).toBeDefined();
    expect(postProcessesMeetings(extraction as AutomationDraft)).toBe(false);
    expect(meetingSetupPlan(facts({ rules: [extraction as AutomationDraft] })).rule).not.toBeNull();
    const archive = AUTOMATION_PRESETS[0] as AutomationDraft;
    expect(postProcessesMeetings(archive)).toBe(false);
  });

  it('never writes over a file already called After a meeting, whatever it holds', () => {
    const plan = meetingSetupPlan(facts({ takenPaths: ['.atlas/automations/after a meeting.md'] }));
    expect(plan.rule).toBeNull();
    expect(plan.lines[0]?.written).toBe(false);
    expect(plan.lines[0]?.detail).toContain('There is already an automation called');
    // No rule names the prompt, so it is not offered on its own either.
    expect(plan.prompt).toBeNull();
  });

  it('keeps a prompt note that is there, the person’s own or DFAI’s', () => {
    const plan = meetingSetupPlan(facts({ promptHeld: true }));
    expect(plan.prompt).toBeNull();
    expect(plan.lines[1]).toEqual({
      kind: 'prompt',
      what: `The prompt ${PROMPT}`,
      detail: 'Already there: kept as it is.',
      written: false,
    });
  });

  it('writes the prompt an existing rule names when the note is missing', () => {
    const plan = meetingSetupPlan(facts({ rules: [AFTER_A_MEETING_PRESET] }));
    expect(plan.rule).toBeNull();
    expect(plan.prompt).toBe(PROMPT);
  });

  it('offers no prompt for a rule that names one of the person’s own', () => {
    const own: AutomationDraft = {
      ...AFTER_A_MEETING_PRESET,
      action: { ...AFTER_A_MEETING_PRESET.action, prompt: '.atlas/prompts/mine.md' } as never,
    };
    const plan = meetingSetupPlan(facts({ rules: [own] }));
    expect(plan.prompt).toBeNull();
    expect(plan.lines.map((line) => line.what)).not.toContain(`The prompt ${PROMPT}`);
  });

  it('gives each type only the keys it lacks, and none to a type that has them all', () => {
    const meeting = type({
      name: 'Meeting',
      label: 'Meeting',
      properties: { tasks: { kind: 'relation', target: 'task', many: true } },
    });
    const task = type({
      name: 'task',
      label: 'Task',
      properties: { meeting: { kind: 'relation', target: 'meeting' }, atlas_item: 'text' },
    });
    const plan = meetingSetupPlan(facts({ types: [meeting, task] }));
    expect(plan.extensions).toHaveLength(1);
    expect(keys(plan.extensions[0]?.added)).toEqual(MEETING_KEYS.filter((key) => key !== 'tasks'));
    expect(plan.lines[3]).toEqual({
      kind: 'type',
      what: 'The Task type',
      detail: 'Already has every key it needs.',
      written: false,
    });
  });

  it('extends no type the vault lacks, or two files claim, and says why', () => {
    const none = meetingSetupPlan(facts({ types: [] }));
    expect(none.extensions).toEqual([]);
    expect(none.lines[2]?.detail).toContain('The vault has no Meeting type');
    expect(none.lines[3]?.detail).toContain('The vault has no Task type');
    const twice = meetingSetupPlan(
      facts({ types: [MEETING, { ...MEETING, name: 'Meeting' }, TASK] }),
    );
    expect(twice.extensions.map((extension) => extension.before.name)).toEqual(['task']);
    expect(twice.lines[2]?.detail).toContain('Two files define the Meeting type');
  });

  it('asks for no emails once selfEmails holds some, but does while only Granola’s key does', () => {
    const kept = meetingSetupPlan(
      facts({
        selfEmails: { emails: ['mara.quill@example.com'], source: 'selfEmails', problem: null },
      }),
    );
    expect(kept.asksEmails).toBe(false);
    expect(kept.lines.at(-1)).toMatchObject({ written: false });
    expect(kept.lines.at(-1)?.detail).toContain('mara.quill@example.com');
    const inherited = meetingSetupPlan(
      facts({
        selfEmails: {
          emails: ['mara.quill@example.com'],
          source: 'granola_self_emails',
          problem: null,
        },
      }),
    );
    expect(inherited.asksEmails).toBe(true);
  });

  it('is complete once the rule, prompt and keys are all there', () => {
    const done = meetingSetupPlan(
      facts({
        types: [],
        rules: [AFTER_A_MEETING_PRESET],
        promptHeld: true,
      }),
    );
    expect(meetingSetupComplete(done)).toBe(true);
    expect(meetingSetupComplete({ ...done, prompt: PROMPT as never })).toBe(false);
    expect(meetingSetupComplete({ ...done, rule: AFTER_A_MEETING_PRESET })).toBe(false);
  });
});

describe('meetingSetupWithin', () => {
  it('writes nothing the preview did not show, even if the vault came to lack it since', () => {
    const shown = meetingSetupPlan(
      facts({ rules: [AFTER_A_MEETING_PRESET], promptHeld: true, types: [MEETING] }),
    );
    const now = meetingSetupPlan(facts());
    const within = meetingSetupWithin(shown, now);
    expect(within.rule).toBeNull();
    expect(within.prompt).toBeNull();
    expect(within.extensions.map((extension) => extension.before.name)).toEqual(['meeting']);
  });

  it('skips what arrived while the preview waited', () => {
    const shown = meetingSetupPlan(facts());
    const now = meetingSetupPlan(
      facts({
        rules: [AFTER_A_MEETING_PRESET],
        promptHeld: true,
        selfEmails: { emails: ['mara.quill@example.com'], source: 'selfEmails', problem: null },
      }),
    );
    const within = meetingSetupWithin(shown, now);
    expect(within.rule).toBeNull();
    expect(within.prompt).toBeNull();
    expect(within.asksEmails).toBe(false);
  });

  it('gives a type only keys the preview named and it still lacks', () => {
    const partial = type({ name: 'meeting', label: 'Meeting', properties: { tasks: 'text' } });
    const shown = meetingSetupPlan(facts({ types: [partial, TASK] }));
    // Since the preview, `tasks` was taken off and `decisions` was added by hand.
    const edited = type({ name: 'meeting', label: 'Meeting', properties: { decisions: 'text' } });
    const within = meetingSetupWithin(shown, meetingSetupPlan(facts({ types: [edited, TASK] })));
    const meeting = within.extensions.find((extension) => extension.before.name === 'meeting');
    expect(keys(meeting?.added)).not.toContain('tasks');
    expect(keys(meeting?.added)).not.toContain('decisions');
    expect(keys(meeting?.added)).toContain('atlas_summary_digest');
  });

  it('keeps what both the preview and the vault now still want', () => {
    const shown = meetingSetupPlan(facts());
    const within = meetingSetupWithin(shown, meetingSetupPlan(facts()));
    expect(within.rule).toBe(AFTER_A_MEETING_PRESET);
    expect(within.prompt).toBe(PROMPT);
    expect(within.extensions).toHaveLength(2);
    expect(within.asksEmails).toBe(true);
  });
});
