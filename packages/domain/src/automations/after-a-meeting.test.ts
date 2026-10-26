import { describe, expect, it } from 'vitest';
import { parseObjectType } from '../types/property-def.ts';
import { checkAtlasQuery } from '../query-language/check.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { CLAUDE_ASKS_PER_RUN } from './answered-note.ts';
import {
  asksSpentInHour,
  NOTE_RUNS_PER_HOUR,
  noteRunsCappedProblem,
  noteRunsHeldUntil,
} from './automation-due.ts';
import {
  automationFrontmatter,
  draftProblem,
  parseAutomationRule,
  type AutomationDraft,
} from './automation-rule.ts';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  MEETING_EXTRACTION_PROMPT,
} from './built-in-prompts.ts';
import {
  claudeAskRefusal,
  claudeRunAsks,
  claudeStepBudget,
  claudeStepDefaultModel,
  claudeStepModel,
  DECLARED_STEP_ASKS_PER_HOUR,
  DECLARED_STEP_ASKS_PER_RUN,
  DECLARED_STEP_MODEL,
  sharesAskAllowance,
} from './claude-step-budget.ts';
import { withClaudeChoices, type ClaudeAction } from './claude-step.ts';
import { AUTOMATION_PRESETS } from './presets.ts';
import type { LogEntry } from './run-log.ts';

/**
 * #179, ADR-0036 ("Where it runs"; Model) and the ADR-0028 addendum ("The
 * caps"): the "After a meeting" rule. Its Claude step may say `apply: mine`
 * — the declared step, whose owner's own items #180 makes into tasks — and
 * `model:`. The declared step asks Sonnet unless its rule names a model, and
 * has its own ask budget: 10 asks a run, 30 an hour, counted apart from the
 * 20 runs an hour every rule has.
 */

const PATH = createVaultPath('.atlas/automations/After a meeting.md');

const RULE = {
  atlas: 'automation',
  name: 'After a meeting',
  enabled: true,
  when: 'a meeting is created',
  which: 'FROM meeting WHERE date >= @-14d',
  do: 'claude',
  prompt: '.atlas/prompts/after-a-meeting.md',
  tools: [],
  output: 'meeting-items',
};

const read = (frontmatter: Record<string, unknown>) => parseAutomationRule(PATH, frontmatter);
const problemOf = (frontmatter: Record<string, unknown>): string | null => {
  const parsed = read(frontmatter);
  return 'broken' in parsed ? parsed.broken.problem : null;
};
const actionOf = (frontmatter: Record<string, unknown>): ClaudeAction => {
  const parsed = read(frontmatter);
  if ('broken' in parsed) throw new Error(parsed.broken.problem);
  if (parsed.rule.action.kind !== 'claude') throw new Error('not a Claude step');
  return parsed.rule.action;
};
/** The rule as its file would be written, then read back. */
const roundTrip = (frontmatter: Record<string, unknown>) => {
  const parsed = read(frontmatter);
  if ('broken' in parsed) throw new Error(parsed.broken.problem);
  const written = automationFrontmatter(parsed.rule);
  return { action: parsed.rule.action, written, again: read(written) };
};

describe('apply: on a rule’s Claude step', () => {
  it('reads apply: mine, in any case and with space around it', () => {
    expect(actionOf({ ...RULE, apply: 'mine' }).apply).toBe('mine');
    expect(actionOf({ ...RULE, apply: '  Mine ' }).apply).toBe('mine');
  });

  it('takes no apply, or a blank one, as proposals only: the key is left out', () => {
    for (const apply of [undefined, null, '', '  ']) {
      expect(actionOf({ ...RULE, apply })).not.toHaveProperty('apply');
    }
  });

  it('refuses any other apply, saying what it may be', () => {
    for (const apply of ['all', 'yes', true, 1, ['mine']]) {
      expect(problemOf({ ...RULE, apply })).toBe(
        'Write apply: mine to make your own action items into tasks, or leave it out for proposals only.',
      );
    }
  });

  it('refuses apply: mine on a step whose output has no action items to apply', () => {
    const wanted =
      'apply: mine makes your own action items out of a meeting into tasks; ' +
      'it needs output: meeting-items or output: meeting-digest.';
    expect(problemOf({ ...RULE, apply: 'mine', output: 'proposals' })).toBe(wanted);
    expect(problemOf({ ...RULE, apply: 'mine', output: 'note', folder: 'Briefs' })).toBe(wanted);
  });

  it('round-trips with and without apply', () => {
    const mine = roundTrip({ ...RULE, apply: 'mine' });
    expect(mine.written).toMatchObject({ apply: 'mine' });
    expect(mine.again).toMatchObject({ rule: { action: mine.action } });

    const none = roundTrip(RULE);
    expect(none.written).toMatchObject({ apply: null });
    expect(none.again).toMatchObject({ rule: { action: none.action } });
    if ('rule' in none.again) expect(none.again.rule.action).not.toHaveProperty('apply');
  });

  it('is taken out of the file when the rule stops asking Claude', () => {
    const parsed = read({ ...RULE, apply: 'mine', model: 'claude-opus-5-5' });
    if ('broken' in parsed) throw new Error(parsed.broken.problem);
    const archiving = automationFrontmatter({ ...parsed.rule, action: { kind: 'archive' } });
    expect(archiving).toMatchObject({ apply: null, model: null });
  });
});

describe('model: on a rule’s Claude step', () => {
  it('reads the model named, trimmed', () => {
    expect(actionOf({ ...RULE, model: ' claude-opus-5-5 ' }).model).toBe('claude-opus-5-5');
    expect(actionOf({ ...RULE, model: 'claude-opus-5-5[1m]' }).model).toBe('claude-opus-5-5[1m]');
  });

  it('takes no model, or a blank one, as the default: the key is left out', () => {
    for (const model of [undefined, null, '', '   ']) {
      expect(actionOf({ ...RULE, model })).not.toHaveProperty('model');
    }
  });

  it('refuses a model the host would refuse or that is not one id', () => {
    const wanted =
      'Write model: as one model’s id, like claude-sonnet-5-5, or leave it out for the default.';
    for (const model of ['-p', '--model', 'claude opus', 'claude\topus', 42, true, ['x']]) {
      expect(problemOf({ ...RULE, model })).toBe(wanted);
    }
    expect(problemOf({ ...RULE, model: 'c'.repeat(101) })).toBe(wanted);
    expect(problemOf({ ...RULE, model: 'c'.repeat(100) })).toBeNull();
  });

  it('takes only what an id is written in, and refuses any control, format or invisible character', () => {
    for (const model of ['claude-sonnet-5-5', 'vendor/model:tag', 'model@2026-10-01', 'a_b.c']) {
      expect(problemOf({ ...RULE, model })).toBeNull();
    }
    // A byte-order mark or no-break space at an end is no plain space: refused, not trimmed away.
    for (const invisible of ['﻿', ' ', '‮', '‍', '\u0007', '\u007F']) {
      expect(problemOf({ ...RULE, model: `claude-sonnet-5-5${invisible}` })).toMatch(/model:/);
      expect(problemOf({ ...RULE, model: `${invisible}claude-sonnet-5-5` })).toMatch(/model:/);
    }
    for (const model of ['claude;rm', 'claude$HOME', 'claude"x', 'cláude', '-claude']) {
      expect(problemOf({ ...RULE, model })).toMatch(/model:/);
    }
  });

  it('round-trips with and without model', () => {
    const named = roundTrip({ ...RULE, model: 'claude-opus-5-5' });
    expect(named.written).toMatchObject({ model: 'claude-opus-5-5' });
    expect(named.again).toMatchObject({ rule: { action: named.action } });

    const none = roundTrip(RULE);
    expect(none.written).toMatchObject({ model: null });
    if ('rule' in none.again) expect(none.again.rule.action).not.toHaveProperty('model');
  });

  it('holds a draft from the editor to the same rules as a file', () => {
    const parsed = read(RULE);
    if ('broken' in parsed) throw new Error(parsed.broken.problem);
    const draft: AutomationDraft = parsed.rule;
    const step = parsed.rule.action as ClaudeAction;
    expect(draftProblem({ ...draft, action: { ...step, model: '-p' } })).toMatch(/model:/);
    expect(draftProblem({ ...draft, action: { ...step, model: 'claude-opus-5-5' } })).toBeNull();
  });
});

describe('withClaudeChoices: the editor’s apply and model on a step', () => {
  const step = actionOf(RULE);

  it('sets them, and takes each out when cleared', () => {
    const chosen = withClaudeChoices(step, { apply: 'mine', model: 'claude-opus-5-5' });
    expect(chosen).toEqual({ ...step, apply: 'mine', model: 'claude-opus-5-5' });
    expect(withClaudeChoices(chosen, { apply: null, model: '' })).toEqual(step);
  });

  it('keeps a model as typed, so a space typed mid-word is the rule’s to refuse', () => {
    expect(withClaudeChoices(step, { apply: null, model: 'claude ' }).model).toBe('claude ');
  });
});

describe('which model the step asks', () => {
  const step = actionOf(RULE);

  it('is Sonnet for the declared step whose rule names none', () => {
    expect(DECLARED_STEP_MODEL).toBe('claude-sonnet-5-5');
    expect(claudeStepModel({ ...step, apply: 'mine' }, 'claude-opus-5-5')).toBe(
      'claude-sonnet-5-5',
    );
  });

  it('is the rule’s own when it names one, the chat’s included', () => {
    expect(
      claudeStepModel({ ...step, apply: 'mine', model: 'claude-opus-5-5' }, 'claude-chat'),
    ).toBe('claude-opus-5-5');
    expect(claudeStepModel({ ...step, model: 'claude-haiku-5-5' }, 'claude-chat')).toBe(
      'claude-haiku-5-5',
    );
  });

  it('is the chat’s for any other step that names none, as before', () => {
    expect(claudeStepModel(step, 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('says the default the editor shows: Sonnet for the declared step, none of its own for another', () => {
    expect(claudeStepDefaultModel({ ...step, apply: 'mine' })).toBe(DECLARED_STEP_MODEL);
    expect(claudeStepDefaultModel({ ...step, apply: 'mine', model: 'claude-x' })).toBe(
      DECLARED_STEP_MODEL,
    );
    expect(claudeStepDefaultModel(step)).toBeNull();
  });
});

describe('the declared step’s own ask budget', () => {
  const step = actionOf(RULE);
  const declared = claudeStepBudget({ ...step, apply: 'mine' });
  const shared = claudeStepBudget(step);

  it('is 10 asks a run and 30 an hour, apart from the shared cap', () => {
    expect(DECLARED_STEP_ASKS_PER_RUN).toBe(10);
    expect(DECLARED_STEP_ASKS_PER_HOUR).toBe(30);
    expect(declared).toEqual({ asksPerRun: 10, asksPerHour: 30 });
  });

  it('is the shared budget for any other step or action', () => {
    expect(shared).toEqual({ asksPerRun: CLAUDE_ASKS_PER_RUN, asksPerHour: null });
    expect(claudeStepBudget({ kind: 'archive' })).toEqual(shared);
    expect(claudeStepBudget({ kind: 'set', values: { status: 'done' } })).toEqual(shared);
  });

  it('refuses the 11th ask in a run, and not the 10th', () => {
    expect(claudeAskRefusal(declared, 9)).toBeNull();
    expect(claudeAskRefusal(declared, 10)).toBe(
      'It would ask Claude more than 10 times; one run asks at most 10.',
    );
    expect(claudeAskRefusal({ asksPerRun: 3, asksPerHour: null }, 2)).toBeNull();
    expect(claudeAskRefusal({ asksPerRun: 3, asksPerHour: null }, 3)).toBe(
      'It would ask Claude more than 3 times; one run asks at most 3.',
    );
  });
});

describe('the declared step’s hourly allowance', () => {
  const NOW = '2026-10-14T12:00:00';
  const step = actionOf(RULE);
  const declared = claudeStepBudget({ ...step, apply: 'mine' });
  /** One run that asked Claude `asks` times, `minutesAgo` before NOW. */
  const asked = (minutesAgo: number, asks = 1): LogEntry => ({
    kind: 'run',
    at: `2026-10-14T11:${String(60 - minutesAgo).padStart(2, '0')}:00`,
    trigger: 'note',
    done: [],
    left: [],
    capped: false,
    claude: { model: DECLARED_STEP_MODEL, ms: 10, asks },
  });
  /** A run that failed before asking anything: it spends the shared cap. */
  const failed = (minutesAgo: number): LogEntry => ({
    kind: 'failed',
    at: `2026-10-14T11:${String(60 - minutesAgo).padStart(2, '0')}:00`,
    trigger: 'note',
    problem: 'The index could not be read.',
  });
  const times = (count: number, entry: (at: number) => LogEntry) =>
    Array.from({ length: count }, (_, at) => entry(50 - at));

  it('lets the 30th ask of the hour through, and refuses the 31st', () => {
    expect(noteRunsHeldUntil(times(29, asked), NOW, declared)).toBeNull();
    // The oldest of the thirty, 50 minutes ago, leaves the hour at 12:10.
    expect(noteRunsHeldUntil(times(30, asked), NOW, declared)).toBe('2026-10-14T12:10:00');
    expect(noteRunsHeldUntil([asked(50, 25), asked(40, 5)], NOW, declared)).toBe(
      '2026-10-14T12:10:00',
    );
  });

  it('counts only asks inside the hour', () => {
    const old = Array.from({ length: 40 }, () => ({ ...asked(0), at: '2026-10-14T11:00:00' }));
    expect(noteRunsHeldUntil(old, NOW, declared)).toBeNull();
  });

  it('does not spend the shared cap: 20 asks hold a rule without it, and not the step', () => {
    const backlog = times(NOTE_RUNS_PER_HOUR, asked);
    expect(noteRunsHeldUntil(backlog, NOW)).not.toBeNull();
    expect(noteRunsHeldUntil(backlog, NOW, declared)).toBeNull();
  });

  it('is not starved by the shared cap’s other spending, which is counted on its own', () => {
    const others = times(NOTE_RUNS_PER_HOUR - 1, failed);
    expect(noteRunsHeldUntil([...others, ...times(29, asked)], NOW, declared)).toBeNull();
    // The shared cap still holds what it always held: twenty runs that asked nothing.
    expect(noteRunsHeldUntil(times(NOTE_RUNS_PER_HOUR, failed), NOW, declared)).not.toBeNull();
  });

  it('when both are spent, waits for the later of the two to free up', () => {
    // Twenty failed runs from 50 minutes ago free the shared cap at 12:10 at the earliest.
    const runs = Array.from({ length: NOTE_RUNS_PER_HOUR }, () => failed(50));
    // Thirty asks from 20 minutes ago free the step's allowance at 12:40.
    const asks = Array.from({ length: DECLARED_STEP_ASKS_PER_HOUR }, () => asked(20));
    expect(noteRunsHeldUntil([...runs, ...asks], NOW, declared)).toBe('2026-10-14T12:40:00');
    const lateRuns = Array.from({ length: NOTE_RUNS_PER_HOUR }, () => failed(20));
    const earlyAsks = Array.from({ length: DECLARED_STEP_ASKS_PER_HOUR }, () => asked(50));
    expect(noteRunsHeldUntil([...lateRuns, ...earlyAsks], NOW, declared)).toBe(
      '2026-10-14T12:40:00',
    );
  });

  it('says both limits when the step is held, and that the allowance is shared', () => {
    expect(noteRunsCappedProblem('2026-10-14T12:10:00', declared)).toBe(
      `Claude has been asked ${DECLARED_STEP_ASKS_PER_HOUR} times in the last hour by the rules ` +
        'that make your own action items into tasks, the most they may together, ' +
        `or it has used its ${NOTE_RUNS_PER_HOUR} runs. It runs on what changed meanwhile at 12:10.`,
    );
  });

  it('is one allowance for the vault: another declared rule’s asks count against it', () => {
    const mine = times(15, asked);
    const theirs = times(15, asked);
    expect(noteRunsHeldUntil(mine, NOW, declared)).toBeNull();
    expect(noteRunsHeldUntil(mine, NOW, declared, [...mine, ...theirs.slice(1)])).toBeNull();
    expect(noteRunsHeldUntil(mine, NOW, declared, [...mine, ...theirs])).toBe(
      '2026-10-14T12:10:00',
    );
    // The shared runs stay the rule's own: another rule's failed runs do not hold it.
    const othersFailed = times(NOTE_RUNS_PER_HOUR, failed);
    expect(noteRunsHeldUntil([], NOW, declared, othersFailed)).toBeNull();
  });

  it('counts the asks in the hour, from every entry it is given', () => {
    expect(asksSpentInHour([asked(50, 25), asked(40, 4), failed(30)], NOW)).toBe(29);
    expect(asksSpentInHour([{ ...asked(0, 7), at: '2026-10-14T11:00:00' }], NOW)).toBe(0);
    expect(asksSpentInHour([asked(10, 3)], 'not a time')).toBe(0);
  });
});

describe('what one run of the declared step may ask', () => {
  const step = actionOf(RULE);
  const declared = claudeStepBudget({ ...step, apply: 'mine' });
  const shared = claudeStepBudget(step);

  it('asks at most its 10 a run, the reduce among them (planned per meeting by claudeAsks, #184)', () => {
    expect(claudeRunAsks(declared)).toBe(10);
    expect(claudeRunAsks(declared, 20)).toBe(10);
    expect(claudeRunAsks(shared)).toBe(CLAUDE_ASKS_PER_RUN);
  });

  it('never asks past what the hour has left: a run starting at 29 makes one', () => {
    expect(claudeRunAsks(declared, 21)).toBe(9);
    expect(claudeRunAsks(declared, 25)).toBe(5);
    expect(claudeRunAsks(declared, 29)).toBe(1);
    expect(claudeRunAsks(declared, 30)).toBe(0);
    expect(claudeRunAsks(declared, 45)).toBe(0);
    // A step without an allowance of its own is bounded by its run alone.
    expect(claudeRunAsks(shared, 45)).toBe(CLAUDE_ASKS_PER_RUN);
  });

  it('refuses the 31st ask of the hour inside a run, saying the allowance is shared', () => {
    expect(claudeAskRefusal(declared, 0, 29)).toBeNull();
    expect(claudeAskRefusal(declared, 1, 29)).toBe(
      `It would ask Claude more than ${DECLARED_STEP_ASKS_PER_HOUR} times in an hour; the rules ` +
        `that make your own action items into tasks ask at most ${DECLARED_STEP_ASKS_PER_HOUR} an hour together.`,
    );
    expect(claudeAskRefusal(declared, 0, 30)).toMatch(/more than 30 times in an hour/);
    // With the hour to spare, the run's own limit is what refuses.
    expect(claudeAskRefusal(declared, 10, 20)).toBe(
      'It would ask Claude more than 10 times; one run asks at most 10.',
    );
    expect(claudeAskRefusal(shared, 9, 45)).toBeNull();
  });

  it('is shared by every rule that says apply: mine, and no other', () => {
    expect(sharesAskAllowance({ ...step, apply: 'mine' })).toBe(true);
    expect(sharesAskAllowance(step)).toBe(false);
    expect(sharesAskAllowance({ kind: 'archive' })).toBe(false);
  });
});

describe('the ready-made "After a meeting" rule', () => {
  const preset = AUTOMATION_PRESETS.find((each) => each.name === 'After a meeting')!;

  it('is a whole rule: set off by a new meeting of the last 14 days, asking its own prompt', () => {
    expect(preset).toBeDefined();
    expect(draftProblem(preset)).toBeNull();
    expect(preset.enabled).toBe(true);
    expect(preset.when).toEqual({ kind: 'note', type: 'meeting', on: ['created'] });
    expect(preset.which).toBe('FROM meeting WHERE date >= @-14d');
    expect(preset.action).toEqual({
      kind: 'claude',
      prompt: '.atlas/prompts/after-a-meeting.md',
      tools: [],
      output: { kind: 'proposals', schema: 'meeting-digest' },
      apply: 'mine',
    });
    expect(preset.action).not.toHaveProperty('model');
  });

  it('asks Sonnet, with its own budget', () => {
    if (preset.action.kind !== 'claude') throw new Error('not a Claude step');
    expect(claudeStepModel(preset.action, 'claude-opus-5-5')).toBe(DECLARED_STEP_MODEL);
    expect(claudeStepBudget(preset.action)).toEqual({ asksPerRun: 10, asksPerHour: 30 });
  });

  it('takes meetings by a moving date the query language reads', () => {
    const meeting = parseObjectType({
      name: 'meeting',
      label: 'Meeting',
      properties: { date: 'date' },
    });
    expect(() => checkAtlasQuery(parseAtlasQuery(preset.which), [meeting])).not.toThrow();
  });

  it('round-trips through its file', () => {
    const written = automationFrontmatter(preset);
    expect(written).toMatchObject({ apply: 'mine', model: null, output: 'meeting-digest' });
    expect(read(written)).toMatchObject({ rule: { action: preset.action } });
  });

  it('sits beside the meeting extraction rule, which stays as it was', () => {
    expect(AUTOMATION_PRESETS.map((each) => each.name)).toEqual([
      'Archive done tasks after 30 days',
      'Pull actions and decisions out of a new meeting',
      'After a meeting',
      'Friday review',
      'Morning brief',
    ]);
    const extraction = AUTOMATION_PRESETS[1]!;
    expect(extraction.action).toEqual({
      kind: 'claude',
      prompt: MEETING_EXTRACTION_PROMPT,
      tools: [],
      output: { kind: 'proposals', schema: 'meeting-items' },
    });
  });
});

describe('the prompt "After a meeting" asks', () => {
  it('is one DFAI ships, at .atlas/prompts/after-a-meeting.md', () => {
    expect(AFTER_A_MEETING_PROMPT).toBe('.atlas/prompts/after-a-meeting.md');
    expect(builtInPromptAt(AFTER_A_MEETING_PROMPT)?.path).toBe(AFTER_A_MEETING_PROMPT);
  });

  it('gives the assignee rules the domain then judges by', () => {
    const { contents } = builtInPromptAt(AFTER_A_MEETING_PROMPT)!;
    for (const rule of [
      'Cite the turn of the person who takes it on.',
      'written **You** in the transcript',
      'One owner per item.',
      '"we"',
      'Do not guess a person.',
      'DFAI decides',
    ]) {
      expect(contents).toContain(rule);
    }
  });
});
