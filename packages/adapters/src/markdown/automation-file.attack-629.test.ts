import { describe, expect, it } from 'vitest';
import {
  automationFrontmatter,
  createVaultPath,
  parseAutomationRule,
  splitFrontmatter,
  withClaudeSkill,
  type AutomationDraft,
} from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

/**
 * Attack on PR #629 (#169), through the real markdown port: a rule saved
 * from a prompt to a skill and back keeps every byte that is not its
 * `prompt:` or `skill:` line (ADR-0003), keys in another case among them;
 * and every YAML form of `skill:` reads as the one name it writes.
 */
const PATH = createVaultPath('.atlas/automations/Meeting actions.md');
const RULE = [
  '---',
  'atlas: automation',
  'name: Meeting actions   # Mara’s',
  'enabled: true',
  'when: manually',
  "which: 'FROM meeting'",
  'do: claude',
  'prompt: .atlas/prompts/meeting-actions.md',
  'Skill: left-alone',
  'owner: &who Tobias Fenn',
  'reviewer: *who',
  'tools: [atlas_read_note]',
  'output: proposals',
  '---',
  '',
  '# Meeting actions',
  '',
].join('\n');

const readBack = (text: string) =>
  parseAutomationRule(
    PATH,
    remarkMarkdown.frontmatterProperties(splitFrontmatter(text).frontmatter),
  );
const ruleOf = (text: string): AutomationDraft => {
  const read = readBack(text);
  if ('broken' in read) throw new Error(read.broken.problem);
  return read.rule;
};
const saved = (text: string, draft: AutomationDraft) => {
  const { frontmatter, body } = splitFrontmatter(text);
  return remarkMarkdown.updateFrontmatter(frontmatter, automationFrontmatter(draft)) + body;
};
const withSkill = (draft: AutomationDraft, skill: string | null): AutomationDraft => {
  if (draft.action.kind !== 'claude') throw new Error('not a Claude step');
  return { ...draft, action: withClaudeSkill(draft.action, skill) };
};
const otherLines = (text: string) =>
  text.split('\n').filter((line) => !/^(prompt|skill):/.test(line));

describe('a rule moved to a skill and back, through the real port (#629 attack)', () => {
  it('keeps every line but its prompt: and skill: byte for byte', () => {
    const asSkill = saved(RULE, withSkill(ruleOf(RULE), 'weekly-notes'));
    const back = ruleOf(asSkill);
    if (back.action.kind !== 'claude') throw new Error('not a Claude step');
    const asPrompt = saved(asSkill, {
      ...back,
      action: {
        ...withClaudeSkill(back.action, null),
        prompt: '.atlas/prompts/meeting-actions.md',
      },
    });
    expect(otherLines(asSkill)).toEqual(otherLines(RULE));
    expect(otherLines(asPrompt)).toEqual(otherLines(RULE));
    expect(ruleOf(asPrompt)).toEqual(ruleOf(RULE));
  });

  it('leaves a key that only looks like skill: as it was, and reads none from it', () => {
    const asSkill = saved(RULE, withSkill(ruleOf(RULE), 'weekly-notes'));
    expect(asSkill).toContain('\nSkill: left-alone\n');
    expect(asSkill).toContain('\nskill: weekly-notes\n');
    expect(ruleOf(RULE).action).not.toHaveProperty('skill');
  });
});

describe('skill: in each YAML form, through the real port (#629 attack)', () => {
  const ruleWith = (line: string) =>
    RULE.replace('prompt: .atlas/prompts/meeting-actions.md', line);

  it.each([
    'skill: weekly-notes',
    'skill: "weekly-notes"',
    "skill: 'weekly-notes'",
    'skill: >\n  weekly-notes',
    'skill: |-\n  weekly-notes',
    'skill: *who2\nx: 1'.replace('*who2', '&s weekly-notes').replace('x: 1', 'other: *s'),
    'skill: weekly-notes # a note',
  ])('reads %j as the skill weekly-notes', (line) => {
    expect(ruleOf(ruleWith(line)).action).toMatchObject({ skill: 'weekly-notes' });
  });

  it('refuses a duplicated skill: as a file it cannot read, never picking one', () => {
    const read = readBack(ruleWith('skill: weekly-notes\nskill: other-skill'));
    expect(read).toHaveProperty('broken');
  });

  it.each(['123', '1e3', 'null', 'true', 'yes', '2026-01-01'])(
    'writes a skill named %s so that it reads back as that skill',
    (name) => {
      const text = saved(RULE, withSkill(ruleOf(RULE), name));
      expect(ruleOf(text).action).toMatchObject({ skill: name });
    },
  );
});
