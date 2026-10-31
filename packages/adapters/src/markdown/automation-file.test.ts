import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PRESETS,
  automationFrontmatter,
  createVaultPath,
  KeyAsWritten,
  parseAutomationRule,
  splitFrontmatter,
  type AutomationDraft,
} from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

/**
 * P25-01: an automation is its file's frontmatter, written and read by the
 * real markdown port. A rule that set properties nests them under `set:`; a
 * rule edited from archiving to setting and back must read as each in turn,
 * with the person's own words below the frontmatter kept byte for byte.
 */
const PATH = createVaultPath('.atlas/automations/Tidy.md');

const readBack = (text: string) =>
  parseAutomationRule(
    PATH,
    remarkMarkdown.frontmatterProperties(splitFrontmatter(text).frontmatter),
  );

const SETTING: AutomationDraft = {
  name: 'Flag stale work',
  enabled: false,
  when: { kind: 'hourly', every: 6 },
  which: 'FROM task WHERE status = "in progress" AND due < @today',
  olderThanDays: null,
  action: { kind: 'set', values: { status: 'stale: check', points: 3, flagged: true } },
};

describe('an automation file, through the real markdown port', () => {
  it.each([...AUTOMATION_PRESETS, SETTING])('reads back as the rule written: %j', (draft) => {
    const written = automationFrontmatter(draft);
    const kept = Object.fromEntries(Object.entries(written).filter(([, value]) => value !== null));
    const text = `${remarkMarkdown.updateFrontmatter(null, kept)}\n# ${draft.name}\n`;
    expect(readBack(text)).toEqual({
      rule: { ...draft, id: 'Tidy', path: PATH },
      idWritten: false,
    });
  });

  it('switches between archiving and setting, keeping the body as it was', () => {
    const body = '\n# Tidy\n\nWhy: the board gets *crowded*.\n\n- [[Tasks]]\n';
    const first = remarkMarkdown.updateFrontmatter(
      null,
      Object.fromEntries(
        Object.entries(automationFrontmatter(SETTING)).filter(([, value]) => value !== null),
      ),
    );
    const archiving = { ...SETTING, action: { kind: 'archive' } } as AutomationDraft;
    const second = remarkMarkdown.updateFrontmatter(first, automationFrontmatter(archiving));
    expect(second).not.toContain('set:');
    expect(readBack(second + body)).toEqual({
      rule: { ...archiving, id: 'Tidy', path: PATH },
      idWritten: false,
    });
    const third = remarkMarkdown.updateFrontmatter(second, automationFrontmatter(SETTING));
    expect(readBack(third + body)).toEqual({
      rule: { ...SETTING, id: 'Tidy', path: PATH },
      idWritten: false,
    });
    expect(splitFrontmatter(third + body).body).toBe(body);
  });

  it('reads a hand-written rule in plain YAML', () => {
    const text = [
      '---',
      'atlas: automation',
      'name: Archive done tasks',
      'enabled: true',
      'when: daily at 3:00',
      'which: FROM task WHERE status = done',
      'olderThanDays: 30',
      'do: set',
      'set:',
      '  status: archived',
      '---',
      '',
    ].join('\n');
    expect(readBack(text)).toMatchObject({
      rule: {
        when: { kind: 'daily', at: '03:00' },
        olderThanDays: 30,
        action: { kind: 'set', values: { status: 'archived' } },
      },
    });
  });
});

describe('what A25-01 writes, through the real markdown port', () => {
  it('reads back an id that looks like a number as the text it is', () => {
    const written = automationFrontmatter(AUTOMATION_PRESETS[0]!);
    const kept = Object.fromEntries(Object.entries(written).filter(([, value]) => value !== null));
    const text = `${remarkMarkdown.updateFrontmatter(null, { ...kept, id: '007' })}\n`;
    const read = readBack(text);
    expect('rule' in read && read.rule.id).toBe('007');
    expect('rule' in read && read.idWritten).toBe(true);
  });

  it('writes a key back present and empty, keeping the other keys as they were', () => {
    const { frontmatter } = splitFrontmatter(
      '---\nstatus: done # set by a rule\ntitle:   Kept\n---\n',
    );
    const after = remarkMarkdown.updateFrontmatter(frontmatter, {
      status: new KeyAsWritten('status:\n'),
    });
    expect(after).toContain('title:   Kept');
    const properties = remarkMarkdown.frontmatterProperties(splitFrontmatter(after).frontmatter);
    expect(Object.hasOwn(properties, 'status')).toBe(true);
    expect(properties['status']).toBeNull();
  });
});

describe('a Claude step’s prompt or skill, through the real markdown port (#169)', () => {
  const PROMPT_RULE = [
    '---',
    'atlas: automation',
    'name: Meeting actions',
    'enabled: true',
    'when: manually',
    'which: FROM meeting',
    'do: claude',
    'prompt: .atlas/prompts/meeting-actions.md # Mara’s wording',
    'tools: [atlas_read_note]',
    'output: proposals',
    '---',
    '',
    '# Meeting actions',
    '',
  ].join('\n');

  const ruleOf = (text: string): AutomationDraft => {
    const read = readBack(text);
    if ('broken' in read) throw new Error(read.broken.problem);
    return read.rule;
  };
  const saved = (text: string, draft: AutomationDraft) => {
    const { frontmatter, body } = splitFrontmatter(text);
    return remarkMarkdown.updateFrontmatter(frontmatter, automationFrontmatter(draft)) + body;
  };

  it('saves a prompt rule, unchanged, byte for byte as it was', () => {
    expect(saved(PROMPT_RULE, ruleOf(PROMPT_RULE))).toBe(PROMPT_RULE);
  });

  it('saves a rule moved to a skill with skill: and no prompt:, and reads it back', () => {
    const rule = ruleOf(PROMPT_RULE);
    if (rule.action.kind !== 'claude') throw new Error('not a Claude step');
    const action = {
      ...rule.action,
      prompt: '.atlas/skills/meeting-actions/SKILL.md',
      skill: 'meeting-actions',
    };
    const text = saved(PROMPT_RULE, { ...rule, action });
    expect(text).toContain('skill: meeting-actions');
    expect(text).not.toContain('prompt:');
    expect(text.endsWith('\n# Meeting actions\n')).toBe(true);
    expect(ruleOf(text).action).toEqual(action);
  });

  it('refuses a hand-written rule that names both, asking for one', () => {
    const both = PROMPT_RULE.replace('do: claude', 'do: claude\nskill: meeting-actions');
    expect(readBack(both)).toMatchObject({
      broken: { problem: expect.stringMatching(/^Name one/) },
    });
  });
});
