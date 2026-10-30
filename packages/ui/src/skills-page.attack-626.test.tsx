// @vitest-environment jsdom
/**
 * Attack on PR #626 (#169): what the description's counter says aloud at
 * each boundary of its limit, and what the field is described by.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SkillsPage, type SkillEditorState, type SkillsPageProps } from './skills-page.tsx';

const LIMIT = 1024;

function editorOf(overrides: Partial<SkillEditorState> = {}): SkillEditorState {
  return {
    mode: 'edit',
    draft: { name: 'weekly-review', description: 'Reviews.', instructions: 'Step.' },
    problems: [],
    fileProblems: [],
    descriptionLength: 8,
    descriptionLimit: LIMIT,
    changedOnDisk: false,
    saving: false,
    canSave: true,
    justCreated: false,
    saveRefusal: null,
    deleting: false,
    ...overrides,
  };
}

function show(editor: SkillEditorState) {
  const props: SkillsPageProps = {
    skills: {
      items: [{ name: 'weekly-review', description: 'Reviews.', problems: [] }],
      error: null,
    },
    prompts: { items: [], error: null },
    selected: 'weekly-review',
    editor,
    notice: null,
    deleteQuestion: null,
    discardQuestion: null,
    focusTarget: null,
    onFocused: vi.fn(),
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onReload: vi.fn(),
    onClose: vi.fn(),
    onOpenPrompt: vi.fn(),
  };
  render(<SkillsPage {...props} />);
}

const spoken = (length: number) => {
  show(editorOf({ descriptionLength: length }));
  return document.querySelector('[aria-live="polite"].skills__count-live')?.textContent;
};

afterEach(cleanup);

describe('the description counter’s live region, at its boundaries (#626 attack)', () => {
  it('is quiet with 101 left', () => expect(spoken(LIMIT - 101)).toBe(''));
  it('speaks with 100 left', () => expect(spoken(LIMIT - 100)).toBe('100 characters left'));
  it('speaks with 99 left', () => expect(spoken(LIMIT - 99)).toBe('99 characters left'));
  it('says none are left at the limit', () => expect(spoken(LIMIT)).toBe('0 characters left'));
  it('says one character left in the singular', () =>
    expect(spoken(LIMIT - 1)).toBe('1 character left'));
  it('says one character over in the singular', () =>
    expect(spoken(LIMIT + 1)).toBe('1 character over the limit'));
});

describe('the description’s aria-describedby (#626 attack)', () => {
  const problem = {
    field: 'description',
    message: 'Keep the description to 1,024 characters.',
  } as SkillEditorState['problems'][number];

  it('names only the counter while there is no problem, and the counter exists', () => {
    show(editorOf());
    const ids = screen
      .getByRole('textbox', { name: /Description/ })
      .getAttribute('aria-describedby');
    expect(ids?.split(' ')).toEqual(['skill-description-count']);
    expect(document.getElementById('skill-description-count')).not.toBeNull();
  });

  it('names the counter and the problem, and each id is drawn, while there is one', () => {
    show(editorOf({ problems: [problem], descriptionLength: 1030 }));
    const ids =
      screen.getByRole('textbox', { name: /Description/ }).getAttribute('aria-describedby') ?? '';
    expect(ids.split(' ')).toEqual(['skill-description-count', 'skill-description-problem']);
    for (const id of ids.split(' ')) expect(document.getElementById(id)).not.toBeNull();
    expect(document.getElementById('skill-description-problem')?.textContent).toContain(
      problem.message,
    );
  });
});
