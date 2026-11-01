// @vitest-environment jsdom
/**
 * "Ask Claude" as what a rule does, where the platform has no Claude Code
 * (#657): not offered for a new step, still shown for a rule that asks it.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AUTOMATION_PRESETS, type AutomationDraft } from '@dfai/domain';
import { AutomationEditor } from './automation-editor.tsx';

const ARCHIVING = AUTOMATION_PRESETS.find(
  (each) => each.name === 'Archive done tasks after 30 days',
)!;
const ASKING = AUTOMATION_PRESETS.find((each) => each.name === 'Friday review')!;

function drawn(draft: AutomationDraft, offersClaude: boolean) {
  render(
    <AutomationEditor
      offersClaude={offersClaude}
      draft={draft}
      onChange={() => {}}
      isNew
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
    />,
  );
  const actions = screen.getByRole('radiogroup', { name: 'What it does' });
  return within(actions)
    .getAllByRole('radio')
    .map((choice) => choice.textContent);
}

describe('AutomationEditor, by platform (#657)', () => {
  it('offers Ask Claude where Claude Code runs', () => {
    expect(ARCHIVING.action.kind).toBe('archive');
    expect(drawn(ARCHIVING, true)).toEqual(['Archive', 'Set a property', 'Ask Claude']);
  });

  it('offers no Ask Claude for a rule that does not ask it, where it does not', () => {
    expect(drawn(ARCHIVING, false)).toEqual(['Archive', 'Set a property']);
  });

  it('still shows what a rule that asks Claude does, so the editor never hides its own step', () => {
    expect(ASKING.action.kind).toBe('claude');
    expect(drawn(ASKING, false)).toEqual(['Archive', 'Set a property', 'Ask Claude']);
  });
});
