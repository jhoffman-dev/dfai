import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { automationFrontmatter, draftProblem, parseAutomationRule } from './automation-rule.ts';
import { FRIDAY_REVIEW_PROMPT } from './built-in-prompts.ts';
import { readsData, withClaudeChoices, withClaudeData, type ClaudeAction } from './claude-step.ts';
import { AUTOMATION_PRESETS } from './presets.ts';

/**
 * #40: a Claude step handed data — the weekly review — beside its notes. It
 * writes one note, and needs no query: what it reads is its data.
 */

const PATH = createVaultPath('.atlas/automations/Friday review.md');
const RULE = {
  atlas: 'automation',
  name: 'Friday review',
  enabled: true,
  when: 'fridays at 15:00',
  do: 'claude',
  prompt: '.atlas/prompts/friday-review.md',
  output: 'note',
  folder: 'Reviews',
  data: 'weekly-review',
};

const read = (frontmatter: Record<string, unknown>) => parseAutomationRule(PATH, frontmatter);
const problemOf = (frontmatter: Record<string, unknown>): string | null => {
  const parsed = read(frontmatter);
  return 'broken' in parsed ? parsed.broken.problem : null;
};

describe('a Claude step with data: weekly-review', () => {
  it('reads its data, its weekly schedule, and no query', () => {
    const parsed = read(RULE);
    if ('broken' in parsed) throw new Error(parsed.broken.problem);
    expect(parsed.rule.when).toEqual({ kind: 'weekly', day: 'friday', at: '15:00' });
    expect(parsed.rule.which).toBe('');
    expect(parsed.rule.action).toEqual({
      kind: 'claude',
      prompt: '.atlas/prompts/friday-review.md',
      tools: [],
      output: { kind: 'note', folder: 'Reviews' },
      data: 'weekly-review',
    });
  });

  it('reads the data however it is cased or spaced, and a blank as none', () => {
    const parsed = read({ ...RULE, data: '  Weekly-Review ' });
    expect('rule' in parsed && parsed.rule.action).toMatchObject({ data: 'weekly-review' });
    const blank = read({ ...RULE, data: '', which: 'FROM task' });
    expect('rule' in blank && blank.rule.action).not.toHaveProperty('data');
  });

  it('refuses data it does not know, and data with an output that is not a note', () => {
    const queried = { ...RULE, which: 'FROM task' };
    expect(problemOf({ ...queried, data: 'calendar' })).toBe(
      'Write data: weekly-review or meeting-briefs, or leave it out.',
    );
    expect(problemOf({ ...queried, data: 3 })).toBe(
      'Write data: weekly-review or meeting-briefs, or leave it out.',
    );
    expect(problemOf({ ...RULE, output: 'proposals', which: 'FROM task' })).toBe(
      'data: weekly-review goes with output: note, the one note it is written into.',
    );
  });

  it('still needs a query when it is handed no data', () => {
    expect(problemOf({ ...RULE, data: null })).toBe(
      'Say which notes it takes, as a query: FROM task WHERE …',
    );
    expect(problemOf({ ...RULE, do: 'archive' })).toBe(
      'Say which notes it takes, as a query: FROM task WHERE …',
    );
  });

  it('writes its data into the file, and reads back as it was written', () => {
    const parsed = read(RULE);
    if ('broken' in parsed) throw new Error(parsed.broken.problem);
    const written = automationFrontmatter(parsed.rule);
    expect(written).toMatchObject({ when: 'fridays at 15:00', which: '', data: 'weekly-review' });
    const again = read({ ...written, id: parsed.rule.id });
    expect('rule' in again && again.rule).toEqual(parsed.rule);
    // A rule that stops being one writes no data key.
    expect(automationFrontmatter({ ...parsed.rule, action: { kind: 'archive' } })).toMatchObject({
      data: null,
    });
  });
});

describe('readsData', () => {
  it('is a Claude step handed data, and nothing else', () => {
    const step: ClaudeAction = {
      kind: 'claude',
      prompt: FRIDAY_REVIEW_PROMPT,
      tools: [],
      output: { kind: 'note', folder: 'Reviews' },
    };
    expect(readsData({ ...step, data: 'weekly-review' })).toBe(true);
    expect(readsData(step)).toBe(false);
    expect(readsData({ kind: 'archive' })).toBe(false);
  });
});

describe('the editor’s choices keep the data, and set it', () => {
  const step: ClaudeAction = {
    kind: 'claude',
    prompt: FRIDAY_REVIEW_PROMPT,
    tools: ['atlas_search'],
    output: { kind: 'note', folder: 'Reviews' },
    model: 'claude-opus-5-5',
    data: 'weekly-review',
  };

  it('keeps the data when the model changes', () => {
    expect(withClaudeChoices(step, { apply: null, model: 'claude-sonnet-5-5' })).toEqual({
      ...step,
      model: 'claude-sonnet-5-5',
    });
  });

  it('sets the data, or takes it out, keeping everything else', () => {
    const without: ClaudeAction = {
      kind: 'claude',
      prompt: FRIDAY_REVIEW_PROMPT,
      tools: ['atlas_search'],
      output: { kind: 'note', folder: 'Reviews' },
      model: 'claude-opus-5-5',
    };
    expect(withClaudeData(step, null)).toEqual(without);
    expect(withClaudeData(without, 'weekly-review')).toEqual(step);
  });
});

describe('the Friday review preset', () => {
  const preset = AUTOMATION_PRESETS.find((each) => each.name === 'Friday review')!;

  it('runs on Fridays at 15:00 and writes into Reviews/ from the weekly review', () => {
    expect(preset).toEqual({
      name: 'Friday review',
      enabled: true,
      when: { kind: 'weekly', day: 'friday', at: '15:00' },
      which: '',
      olderThanDays: null,
      action: {
        kind: 'claude',
        prompt: FRIDAY_REVIEW_PROMPT,
        tools: [],
        output: { kind: 'note', folder: 'Reviews' },
        data: 'weekly-review',
      },
    });
    expect(draftProblem(preset)).toBeNull();
  });
});
