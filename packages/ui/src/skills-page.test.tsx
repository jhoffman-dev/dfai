// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SkillDraft, SkillProblem } from '@dfai/domain';
import { SkillsPage, type SkillEditorState, type SkillsPageProps } from './skills-page.tsx';

const SKILLS: SkillsPageProps['skills'] = {
  items: [
    { name: 'weekly-review', description: 'Reviews the week with Mara Quill.', problems: [] },
    {
      name: 'Draft-Notes',
      description: '',
      problems: ['Its folder: A skill’s name is lowercase letters.', 'Say what the skill does.'],
    },
  ],
  error: null,
};

const PROMPTS: SkillsPageProps['prompts'] = {
  items: [{ name: 'morning-brief', path: '.atlas/prompts/morning-brief.md' }],
  error: null,
};

const DRAFT: SkillDraft = {
  name: 'weekly-review',
  description: 'Reviews the week.',
  instructions: 'Read the week’s notes.',
};

function editorOf(overrides: Partial<SkillEditorState> = {}): SkillEditorState {
  return {
    mode: 'edit',
    draft: DRAFT,
    problems: [],
    fileProblems: [],
    descriptionLength: 17,
    descriptionLimit: 1024,
    changedOnDisk: false,
    saving: false,
    ...overrides,
  };
}

function show(overrides: Partial<SkillsPageProps> = {}) {
  const props: SkillsPageProps = {
    skills: SKILLS,
    prompts: PROMPTS,
    selected: null,
    editor: null,
    notice: null,
    deleteQuestion: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onReload: vi.fn(),
    onClose: vi.fn(),
    onOpenPrompt: vi.fn(),
    ...overrides,
  };
  render(<SkillsPage {...props} />);
  return props;
}

/** The page over a draft it holds, as the hook does, with `problemsOf` standing in for the domain. */
function Editing({
  mode,
  problemsOf,
  onSave,
}: {
  mode: 'new' | 'edit';
  problemsOf: (draft: SkillDraft) => SkillProblem[];
  onSave: () => void;
}) {
  const [draft, setDraft] = useState<SkillDraft>(
    mode === 'new' ? { name: '', description: '', instructions: '' } : DRAFT,
  );
  return (
    <SkillsPage
      skills={SKILLS}
      prompts={PROMPTS}
      selected={mode === 'new' ? null : DRAFT.name}
      editor={editorOf({
        mode,
        draft,
        problems: problemsOf(draft),
        descriptionLength: Array.from(draft.description).length,
      })}
      notice={null}
      deleteQuestion={null}
      onSelect={vi.fn()}
      onNew={vi.fn()}
      onChange={(change) => setDraft((was) => ({ ...was, ...change }))}
      onSave={onSave}
      onDelete={vi.fn()}
      onReload={vi.fn()}
      onClose={vi.fn()}
      onOpenPrompt={vi.fn()}
    />
  );
}

const nameProblem = (draft: SkillDraft): SkillProblem[] =>
  /^[a-z0-9-]+$/.test(draft.name)
    ? []
    : [{ field: 'name', message: 'A skill’s name is lowercase letters, digits and hyphens.' }];

describe('SkillsPage', () => {
  it('lists each skill with its description and its problems, in the words it is handed', () => {
    show();
    const list = screen.getByRole('region', { name: 'Skills' });
    const good = within(list).getByRole('button', { name: /^weekly-review/ });
    expect(good.textContent).toContain('Reviews the week with Mara Quill.');
    expect(within(good).queryByText(/problem/)).toBeNull();
    const bad = within(list).getByRole('button', { name: /^Draft-Notes/ });
    expect(within(bad).getByText('2 problems')).toBeTruthy();
    expect(within(bad).getByText('Its folder: A skill’s name is lowercase letters.')).toBeTruthy();
    expect(within(bad).getByText('Say what the skill does.')).toBeTruthy();
  });

  it('opens a skill when its row is pressed', async () => {
    const props = show();
    await userEvent.click(screen.getByRole('button', { name: /^weekly-review/ }));
    expect(props.onSelect).toHaveBeenCalledWith('weekly-review');
  });

  it('lists the prompt notes as Automation prompts, each with Open', async () => {
    const props = show();
    const prompts = screen.getByRole('region', { name: 'Automation prompts' });
    expect(within(prompts).getByText('morning-brief')).toBeTruthy();
    await userEvent.click(
      within(prompts).getByRole('button', { name: 'Open morning-brief prompt' }),
    );
    expect(props.onOpenPrompt).toHaveBeenCalledWith('.atlas/prompts/morning-brief.md');
  });

  it('says why a list could not be read, and while it is read', () => {
    show({
      skills: { items: null, error: 'The skills could not be read: denied' },
      prompts: { items: null, error: null },
    });
    expect(screen.getByRole('alert').textContent).toBe('The skills could not be read: denied');
    const prompts = screen.getByRole('region', { name: 'Automation prompts' });
    expect(within(prompts).getByText('Reading…')).toBeTruthy();
  });

  it('counts the description against its limit, and marks it when over', () => {
    show({ selected: 'weekly-review', editor: editorOf({ descriptionLength: 17 }) });
    const count = screen.getByLabelText('17 of 1024 characters');
    expect(count.textContent).toBe('17/1024');
    expect(count.className).not.toContain('skills__count--over');
  });

  it('marks a count over the limit', () => {
    show({ selected: 'weekly-review', editor: editorOf({ descriptionLength: 1025 }) });
    expect(screen.getByLabelText('1025 of 1024 characters').className).toContain(
      'skills__count--over',
    );
  });

  it('counts what is typed as the length it is handed, emoji as one character', async () => {
    render(<Editing mode="edit" problemsOf={() => []} onSave={vi.fn()} />);
    const description = screen.getByRole('textbox', { name: /Description/ });
    await userEvent.clear(description);
    await userEvent.type(description, 'Hi 🌿');
    expect(screen.getByLabelText('4 of 1024 characters').textContent).toBe('4/1024');
  });

  it('shows a field’s problem under it and keeps Save off while there is any', async () => {
    const onSave = vi.fn();
    render(<Editing mode="new" problemsOf={nameProblem} onSave={onSave} />);
    const editor = screen.getByRole('form', { name: 'New skill' });
    const save = within(editor).getByRole('button', { name: 'Save' });
    // An empty new skill is not yet wrong to look at, but cannot be saved.
    expect(within(editor).queryByText(/lowercase letters/)).toBeNull();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    const name = within(editor).getByRole('textbox', { name: 'Name' });
    await userEvent.type(name, 'Weekly');
    expect(within(editor).getByText(/lowercase letters, digits and hyphens/)).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(name, '{Enter}');
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.clear(name);
    await userEvent.type(name, 'weekly');
    expect(within(editor).queryByText(/lowercase letters/)).toBeNull();
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('keeps an existing skill’s name fixed, and shows its problems at once', () => {
    show({
      selected: 'weekly-review',
      editor: editorOf({
        problems: [
          { field: 'description', message: 'A skill’s description cannot hold XML tags.' },
        ],
        fileProblems: ['SKILL.md says its name is “weekly”.'],
      }),
    });
    const editor = screen.getByRole('form', { name: 'Skill weekly-review' });
    expect(
      (within(editor).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(within(editor).getByText('A skill’s description cannot hold XML tags.')).toBeTruthy();
    const onDisk = within(editor).getByRole('list', { name: 'Problems with SKILL.md' });
    expect(onDisk.textContent).toBe('SKILL.md says its name is “weekly”.');
    expect(
      (within(editor).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('lets a new skill be named, and offers no Delete for one not yet made', () => {
    show({ editor: editorOf({ mode: 'new', draft: { ...DRAFT, name: '' } }) });
    const editor = screen.getByRole('form', { name: 'New skill' });
    expect(
      (within(editor).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).readOnly,
    ).toBe(false);
    expect(within(editor).queryByRole('button', { name: 'Delete…' })).toBeNull();
    expect(within(editor).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('offers Reload when the file changed on disk, and only then', async () => {
    const props = show({ selected: 'weekly-review', editor: editorOf({ changedOnDisk: true }) });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('changed on disk');
    await userEvent.click(within(status).getByRole('button', { name: 'Reload' }));
    expect(props.onReload).toHaveBeenCalledOnce();
  });

  it('has no Reload while the file is as it was read', () => {
    show({ selected: 'weekly-review', editor: editorOf() });
    expect(screen.getByRole('form', { name: 'Skill weekly-review' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('asks for Delete and says, in the words handed in, what goes', async () => {
    const props = show({ selected: 'weekly-review', editor: editorOf() });
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(props.onDelete).toHaveBeenCalledOnce();
  });

  it('confirms a delete before it happens, and Cancel answers no', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const warning =
      'Delete “weekly-review”? Its whole folder goes to the Trash, with 1 other file: scripts/run.sh';
    show({
      selected: 'weekly-review',
      editor: editorOf(),
      deleteQuestion: { warning, onConfirm, onCancel },
    });
    const question = screen.getByRole('alertdialog', { name: 'Delete this skill?' });
    expect(question.textContent).toContain(warning);
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('moves the skill to the Trash only on Move to Trash', async () => {
    const onConfirm = vi.fn();
    show({
      selected: 'weekly-review',
      editor: editorOf(),
      deleteQuestion: { warning: 'Delete “weekly-review”?', onConfirm, onCancel: vi.fn() },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('says why the last command failed', () => {
    show({ notice: 'The skill could not be saved: denied' });
    expect(screen.getByRole('alert').textContent).toBe('The skill could not be saved: denied');
  });
});
