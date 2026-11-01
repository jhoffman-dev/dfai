// @vitest-environment jsdom
/*
 * Attack on PR #699 (#657): the editor, where no Claude Code runs, opened on
 * a rule a desktop wrote that asks Claude.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AUTOMATION_PRESETS, type AutomationDraft } from '@dfai/domain';
import { AutomationEditor } from './automation-editor.tsx';

const ASKING = AUTOMATION_PRESETS.find((each) => each.name === 'Friday review')!;

/** The editor as the screen holds it: the draft in state, changed as the editor says. */
function Editing({ start }: { start: AutomationDraft }) {
  const [draft, setDraft] = useState(start);
  return (
    <AutomationEditor
      offersClaude={false}
      draft={draft}
      onChange={setDraft}
      isNew={false}
      problem={null}
      which={<p>query builder here</p>}
      typeNames={['task']}
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

const actions = () =>
  within(screen.getByRole('radiogroup', { name: 'What it does' }))
    .getAllByRole('radio')
    .map((choice) => choice.textContent);

describe('AutomationEditor without Claude Code (#699 attack)', () => {
  it('still offers Ask Claude after a misclick away from a rule that asks it, so the step can be put back', () => {
    expect(ASKING.action.kind).toBe('claude');
    render(<Editing start={ASKING} />);
    expect(actions()).toContain('Ask Claude');
    fireEvent.click(screen.getByRole('radio', { name: 'Archive' }));
    expect(actions()).toContain('Ask Claude');
  });
});
