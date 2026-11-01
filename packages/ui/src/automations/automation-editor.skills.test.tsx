// @vitest-environment jsdom
/**
 * #169: the automation editor's skill picker. A Claude step asks with a
 * prompt note or one of the vault's skills; picking a skill hides the prompt
 * path and writes `skill:` with no `prompt:` into the rule's file.
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  automationFrontmatter,
  createVaultPath,
  draftProblem,
  type AutomationDraft,
} from '@dfai/domain';
import { AutomationEditor, type SkillChoice } from './automation-editor.tsx';

const BY_PROMPT: AutomationDraft = {
  name: 'Meeting actions',
  enabled: true,
  when: { kind: 'manual' },
  which: 'FROM meeting',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: '.atlas/prompts/meeting-actions.md',
    tools: ['atlas_read_note'],
    output: { kind: 'proposals', schema: 'proposals' },
  },
};

function Editor({
  start = BY_PROMPT,
  skills = [
    { name: 'meeting-actions', unusable: null },
    { name: 'weekly-notes', unusable: null },
  ],
  onChange,
}: {
  start?: AutomationDraft;
  skills?: readonly SkillChoice[];
  onChange: (draft: AutomationDraft) => void;
}) {
  const [draft, setDraft] = useState<AutomationDraft>(start);
  return (
    <AutomationEditor
      offersClaude
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        onChange(next);
      }}
      isNew={false}
      problem={null}
      which={<p>query builder here</p>}
      typeNames={['meeting']}
      claudeTools={['atlas_read_note']}
      claudeOutputs={['proposals']}
      skills={skills}
      busy={false}
      onSave={() => {}}
      onCancel={() => {}}
      onDryRun={() => {}}
      onRunNow={() => {}}
      onUndo={() => {}}
      canUndo={false}
      dryRun={null}
      log={[]}
      onOpenNote={() => {}}
    />
  );
}

const picker = () => screen.getByLabelText('Skill') as HTMLSelectElement;
const optionsOf = (select: HTMLSelectElement) =>
  [...select.options].map((option) => option.textContent);

describe('the automation editor’s skill picker', () => {
  it('offers a prompt note and each skill, the prompt path shown for a prompt', () => {
    render(<Editor onChange={vi.fn()} />);
    expect(optionsOf(picker())).toEqual([
      'A prompt note',
      'Skill: meeting-actions',
      'Skill: weekly-notes',
    ]);
    expect(picker().value).toBe('');
    expect((screen.getByLabelText('Prompt') as HTMLInputElement).value).toBe(
      '.atlas/prompts/meeting-actions.md',
    );
  });

  it('picks a skill: the prompt path goes, and the file says skill: with no prompt:', async () => {
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);

    await userEvent.selectOptions(picker(), 'weekly-notes');

    expect(screen.queryByLabelText('Prompt')).toBeNull();
    const last = onChange.mock.lastCall![0] as AutomationDraft;
    expect(automationFrontmatter(last)).toMatchObject({ skill: 'weekly-notes', prompt: null });
    expect(draftProblem(last)).toBeNull();
  });

  it('goes back to a prompt note with an empty path to type, for a rule opened with a skill', async () => {
    const onChange = vi.fn();
    const bySkill: AutomationDraft = {
      ...BY_PROMPT,
      action: {
        kind: 'claude',
        prompt: createVaultPath('.atlas/skills/weekly-notes/SKILL.md'),
        skill: 'weekly-notes',
        tools: ['atlas_read_note'],
        output: { kind: 'proposals', schema: 'proposals' },
      },
    };
    render(<Editor start={bySkill} onChange={onChange} />);

    await userEvent.selectOptions(picker(), '');

    const prompt = screen.getByLabelText('Prompt') as HTMLInputElement;
    expect(prompt.value).toBe('');
    fireEvent.change(prompt, { target: { value: 'meeting-actions' } });
    const last = onChange.mock.lastCall![0] as AutomationDraft;
    expect(automationFrontmatter(last)).toMatchObject({
      prompt: 'meeting-actions',
      skill: null,
    });
    expect(draftProblem(last)).toBeNull();
  });

  it('keeps showing the skill a rule names when the vault no longer has it', () => {
    const named: AutomationDraft = {
      ...BY_PROMPT,
      action: {
        ...BY_PROMPT.action,
        kind: 'claude',
        prompt: createVaultPath('.atlas/skills/gone-skill/SKILL.md'),
        skill: 'gone-skill',
        tools: ['atlas_read_note'],
        output: { kind: 'proposals', schema: 'proposals' },
      },
    };
    render(
      <Editor
        start={named}
        skills={[{ name: 'weekly-notes', unusable: null }]}
        onChange={vi.fn()}
      />,
    );
    expect(picker().value).toBe('gone-skill');
    expect(optionsOf(picker())).toEqual([
      'A prompt note',
      'Skill: gone-skill',
      'Skill: weekly-notes',
    ]);
  });

  it('marks a skill that has problems, or is too long to run, and still lets a rule hold it (#629 review)', async () => {
    const onChange = vi.fn();
    render(
      <Editor
        skills={[
          { name: 'broken-skill', unusable: 'problems' },
          { name: 'long-skill', unusable: 'too-long' },
          { name: 'weekly-notes', unusable: null },
        ]}
        onChange={onChange}
      />,
    );
    expect(optionsOf(picker())).toEqual([
      'A prompt note',
      'Skill: broken-skill (has problems)',
      'Skill: long-skill (too long to run)',
      'Skill: weekly-notes',
    ]);
    await userEvent.selectOptions(picker(), 'broken-skill');
    expect(picker().value).toBe('broken-skill');
    expect((onChange.mock.lastCall![0] as AutomationDraft).action).toMatchObject({
      skill: 'broken-skill',
    });
  });
});
