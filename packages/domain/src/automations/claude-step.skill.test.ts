import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  automationFrontmatter,
  describeAction,
  draftProblem,
  parseAutomationRule,
} from './automation-rule.ts';
import {
  claudeActionFields,
  isClaudeStepPrompt,
  readClaudeAction,
  usesSkill,
  withClaudeChoices,
  withClaudeData,
  withClaudeSkill,
  type ClaudeAction,
} from './claude-step.ts';

/**
 * #169 (ADR-0050, ADR-0028's amendment): a rule's Claude step may name a
 * skill in place of a prompt note. `skill:` and `prompt:` are one or the
 * other; the action keeps the skill's name and holds its SKILL.md as its
 * prompt, so the run reads one path either way.
 */

const PATH = createVaultPath('.atlas/automations/Weekly notes.md');

const RULE = {
  atlas: 'automation',
  name: 'Weekly notes',
  enabled: true,
  when: 'daily at 08:00',
  which: 'FROM note',
  do: 'claude',
  tools: ['atlas_read_note'],
  output: 'proposals',
};

const PROMPT_RULE = { ...RULE, prompt: '.atlas/prompts/meeting-actions.md' };
const SKILL_RULE = { ...RULE, skill: 'weekly-notes' };

const read = (frontmatter: Record<string, unknown>) => readClaudeAction(frontmatter);
const actionOf = (frontmatter: Record<string, unknown>): ClaudeAction => {
  const action = read(frontmatter);
  if (typeof action === 'string') throw new Error(action);
  return action;
};

describe('a Claude step that names a skill', () => {
  it('reads the skill’s name, with its SKILL.md as the prompt', () => {
    expect(actionOf(SKILL_RULE)).toStrictEqual({
      kind: 'claude',
      prompt: '.atlas/skills/weekly-notes/SKILL.md',
      skill: 'weekly-notes',
      tools: ['atlas_read_note'],
      output: { kind: 'proposals', schema: 'proposals' },
    });
  });

  it('takes the name without the spaces round it', () => {
    expect(actionOf({ ...RULE, skill: '  weekly-notes ' }).skill).toBe('weekly-notes');
  });

  it('refuses a rule that names a skill and a prompt, asking for one', () => {
    expect(read({ ...SKILL_RULE, prompt: 'meeting-actions' })).toBe(
      'Name one: prompt: .atlas/prompts/<name>.md, or skill: <name>, not both.',
    );
  });

  it('takes a blank prompt beside a skill as no prompt', () => {
    expect(actionOf({ ...SKILL_RULE, prompt: '  ' }).skill).toBe('weekly-notes');
    expect(actionOf({ ...SKILL_RULE, prompt: null }).skill).toBe('weekly-notes');
  });

  it('refuses a name no skill can have, saying why', () => {
    expect(read({ ...RULE, skill: 'Weekly Notes' })).toMatch(
      /^skill: A skill’s name is lowercase letters/,
    );
    expect(read({ ...RULE, skill: '../prompts/x' })).toMatch(/^skill: /);
    expect(read({ ...RULE, skill: 'ask-claude' })).toBe(
      'skill: A skill’s name cannot hold “claude”.',
    );
  });

  it('refuses a skill that is not written as one name', () => {
    for (const skill of [['weekly-notes'], 42, { name: 'weekly-notes' }]) {
      expect(read({ ...RULE, skill })).toBe(
        'Write skill: as one skill’s name, like skill: weekly-notes.',
      );
    }
  });

  it('is written to its file as skill: with no prompt:, and read back the same', () => {
    const action = actionOf(SKILL_RULE);
    expect(claudeActionFields(action)).toMatchObject({ skill: 'weekly-notes', prompt: null });
    const parsed = parseAutomationRule(PATH, SKILL_RULE);
    if ('broken' in parsed) throw new Error(parsed.broken.problem);
    const written = automationFrontmatter(parsed.rule);
    expect(read(written)).toStrictEqual(action);
  });

  it('keeps its skill through the editor’s choices and data', () => {
    const action = actionOf({ ...SKILL_RULE, output: 'note', folder: 'Briefs' });
    expect(withClaudeChoices(action, { apply: null, model: 'claude-sonnet-5-5' }).skill).toBe(
      'weekly-notes',
    );
    expect(withClaudeData(action, 'weekly-review').skill).toBe('weekly-notes');
  });

  it('is described by the skill’s name', () => {
    expect(describeAction(actionOf(SKILL_RULE))).toBe('Ask Claude (weekly-notes) for proposals');
  });

  it('holds a draft that names a skill to the file’s rules', () => {
    const parsed = parseAutomationRule(PATH, SKILL_RULE);
    if ('broken' in parsed) throw new Error(parsed.broken.problem);
    expect(draftProblem(parsed.rule)).toBeNull();
    const bad = { ...actionOf(SKILL_RULE), skill: 'Not A Name' };
    expect(draftProblem({ ...parsed.rule, action: bad })).toMatch(/^skill: /);
  });
});

describe('a Claude step that names a prompt, as before skills', () => {
  it('reads with no skill key at all', () => {
    const action = actionOf(PROMPT_RULE);
    expect(Object.keys(action)).not.toContain('skill');
    expect(action).toStrictEqual({
      kind: 'claude',
      prompt: '.atlas/prompts/meeting-actions.md',
      tools: ['atlas_read_note'],
      output: { kind: 'proposals', schema: 'proposals' },
    });
  });

  it('takes an empty or absent skill as none', () => {
    expect(actionOf({ ...PROMPT_RULE, skill: '' })).toStrictEqual(actionOf(PROMPT_RULE));
    expect(actionOf({ ...PROMPT_RULE, skill: null })).toStrictEqual(actionOf(PROMPT_RULE));
  });

  it('still asks for a prompt, in the same words, when it names neither', () => {
    expect(read(RULE)).toBe('Name its prompt: prompt: .atlas/prompts/<name>.md.');
  });

  it('writes its prompt and a null skill, which takes out nothing it had', () => {
    expect(claudeActionFields(actionOf(PROMPT_RULE))).toMatchObject({
      prompt: '.atlas/prompts/meeting-actions.md',
      skill: null,
    });
    expect(claudeActionFields(null)).toMatchObject({ prompt: null, skill: null });
  });
});

describe('the prompt a step may run with', () => {
  const prompt = actionOf(PROMPT_RULE);
  const skill = actionOf(SKILL_RULE);

  it('is a prompt note for a step with no skill, and never a SKILL.md', () => {
    expect(isClaudeStepPrompt(prompt)).toBe(true);
    expect(isClaudeStepPrompt({ prompt: '.atlas/skills/weekly-notes/SKILL.md' })).toBe(false);
    expect(isClaudeStepPrompt({ prompt: 'Notes/prompt.md' })).toBe(false);
  });

  it('is exactly its own skill’s SKILL.md for a step with one', () => {
    expect(isClaudeStepPrompt(skill)).toBe(true);
    expect(isClaudeStepPrompt({ ...skill, prompt: '.atlas/skills/other/SKILL.md' })).toBe(false);
    expect(isClaudeStepPrompt({ ...skill, prompt: '.atlas/prompts/meeting-actions.md' })).toBe(
      false,
    );
    expect(isClaudeStepPrompt({ ...skill, skill: '../x' })).toBe(false);
  });
});

describe('the editor’s skill picker', () => {
  const prompt = actionOf(PROMPT_RULE);

  it('puts a skill in, its SKILL.md the prompt, keeping the rest', () => {
    const picked = withClaudeSkill({ ...prompt, model: 'claude-sonnet-5-5' }, 'weekly-notes');
    expect(picked).toMatchObject({
      prompt: '.atlas/skills/weekly-notes/SKILL.md',
      skill: 'weekly-notes',
      model: 'claude-sonnet-5-5',
      tools: ['atlas_read_note'],
    });
  });

  it('takes a skill out, leaving a prompt to type', () => {
    const picked = withClaudeSkill(prompt, 'weekly-notes');
    const left = withClaudeSkill(picked, null);
    expect(left.prompt).toBe('');
    expect(Object.keys(left)).not.toContain('skill');
  });

  it('leaves a prompt as typed when there was no skill to take out', () => {
    expect(withClaudeSkill(prompt, null)).toStrictEqual(prompt);
  });
});

describe('which rules use a skill', () => {
  const skill = actionOf(SKILL_RULE);

  it('is a Claude step naming it, in any case or form', () => {
    expect(usesSkill(skill, 'weekly-notes')).toBe(true);
    expect(usesSkill(skill, 'Weekly-Notes')).toBe(true);
    expect(usesSkill(skill, 'weekly-note')).toBe(false);
  });

  it('is never a step with a prompt, or a rule that does not ask Claude', () => {
    expect(usesSkill(actionOf(PROMPT_RULE), 'meeting-actions')).toBe(false);
    expect(usesSkill({ kind: 'archive' }, 'weekly-notes')).toBe(false);
  });
});
