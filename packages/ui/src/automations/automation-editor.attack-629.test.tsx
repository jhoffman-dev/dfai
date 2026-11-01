// @vitest-environment jsdom
/**
 * Attack on PR #629 (#169): the editor's skill picker, switched from a prompt
 * note to a skill and back before a save. Nothing the person had is lost on
 * the way: the draft that comes back is the draft that went in (ADR-0003).
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
    model: 'claude-opus-5-5',
    apply: 'mine',
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

describe('the skill picker, there and back (#629 attack)', () => {
  it('gives back the prompt note a rule had when a skill picked is let go before saving', async () => {
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    await userEvent.selectOptions(picker(), 'weekly-notes');

    await userEvent.selectOptions(picker(), '');

    expect((screen.getByLabelText('Prompt') as HTMLInputElement).value).toBe(
      '.atlas/prompts/meeting-actions.md',
    );
    expect(onChange.mock.lastCall![0]).toEqual(BY_PROMPT);
  });

  it('keeps every other part of the step through a skill picked and let go', async () => {
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    await userEvent.selectOptions(picker(), 'weekly-notes');
    await userEvent.selectOptions(picker(), '');

    const withoutPrompt = (action: object) =>
      Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'prompt'));
    const rest = withoutPrompt((onChange.mock.lastCall![0] as AutomationDraft).action);
    const before = withoutPrompt(BY_PROMPT.action);
    expect(rest).toEqual(before);
  });

  it('keeps a gone skill through a save of another field, and its file names it still', async () => {
    const onChange = vi.fn();
    const named: AutomationDraft = {
      ...BY_PROMPT,
      action: {
        kind: 'claude',
        prompt: createVaultPath('.atlas/skills/gone-skill/SKILL.md'),
        skill: 'gone-skill',
        tools: ['atlas_read_note'],
        output: { kind: 'proposals', schema: 'proposals' },
      },
    };
    render(<Editor start={named} skills={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    const last = onChange.mock.lastCall![0] as AutomationDraft;
    expect(automationFrontmatter(last)).toMatchObject({ skill: 'gone-skill', prompt: null });
    expect(draftProblem(last)).toBeNull();
  });
});
