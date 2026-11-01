// @vitest-environment jsdom
/**
 * Regression tests from the review of PR #539 (#40): the editor's weekly schedule and the data a
 * Claude step is handed, carried through to the rule's file and back.
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AUTOMATION_PRESETS,
  automationFrontmatter,
  draftProblem,
  parseSchedule,
  type AutomationDraft,
} from '@dfai/domain';
import { AutomationEditor } from './automation-editor.tsx';

const FRIDAY = AUTOMATION_PRESETS.find((each) => each.name === 'Friday review')!;

function Editor({ onChange }: { onChange: (draft: AutomationDraft) => void }) {
  const [draft, setDraft] = useState<AutomationDraft>(FRIDAY);
  return (
    <AutomationEditor
      offersClaude
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        onChange(next);
      }}
      isNew
      problem={null}
      which={<p>query builder here</p>}
      typeNames={['task', 'meeting']}
      claudeTools={['atlas_search']}
      claudeOutputs={['proposals']}
      skills={[]}
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

describe('the editor and the Friday review', () => {
  it('writes the weekly day and time it shows into the file, which reads back as them', async () => {
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('Day of the week'), 'sunday');
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '00:05' } });
    const last = onChange.mock.lastCall![0] as AutomationDraft;
    expect(parseSchedule(automationFrontmatter(last)['when'])).toEqual({
      kind: 'weekly',
      day: 'sunday',
      at: '00:05',
    });
    expect(draftProblem(last)).toBeNull();
  });

  it('takes the weekly review off a step switched to proposals, whose control it hides', async () => {
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('What Claude writes'), 'proposals');
    const last = onChange.mock.lastCall![0] as AutomationDraft;
    // The "given" select is gone with the note output, so the person cannot take the data off.
    expect(screen.queryByLabelText('What DFAI hands Claude')).toBeNull();
    expect(last.action).not.toHaveProperty('data');
  });
});
