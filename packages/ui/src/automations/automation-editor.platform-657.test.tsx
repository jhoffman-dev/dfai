// @vitest-environment jsdom
/**
 * "Ask Claude" as what a rule does, where the platform has no Claude Code
 * (#657): not offered for a new step, still shown for a rule that asks it.
 */
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

  it('puts a rule’s own Claude step back as it was, after a misclick away', () => {
    expect(ASKING.action.kind).toBe('claude');
    const changes: AutomationDraft[] = [];
    function Editing() {
      const [draft, setDraft] = useState(ASKING);
      return (
        <AutomationEditor
          offersClaude={false}
          draft={draft}
          onChange={(next) => {
            changes.push(next);
            setDraft(next);
          }}
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
    render(<Editing />);
    fireEvent.click(screen.getByRole('radio', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Ask Claude' }));
    expect(changes.map((change) => change.action.kind)).toEqual(['archive', 'claude']);
    expect(changes.at(-1)?.action).toEqual(ASKING.action);
  });

  it('still shows what a rule that asks Claude does, so the editor never hides its own step', () => {
    expect(ASKING.action.kind).toBe('claude');
    expect(drawn(ASKING, false)).toEqual(['Archive', 'Set a property', 'Ask Claude']);
  });
});
