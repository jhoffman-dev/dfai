// @vitest-environment jsdom
/**
 * The editor open on a rule that is turned on or off from the list, or by the
 * read-twice offer, while it is open (#793): the switch writes only `enabled`,
 * so the editor takes the rule's on or off as listed again, unless the person
 * changed it there, and keeps every other edit.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AUTOMATION_PRESETS, type AutomationRule } from '@dfai/domain';
import { fakeIndexPort, recordingActivity } from '@dfai/application';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import type { AutomationsController } from './automations-store.ts';
import { useAutomationEditor } from './use-automation-editor.ts';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const RULE = {
  ...AUTOMATION_PRESETS.find(
    (preset) => preset.name === 'Pull actions and decisions out of a new meeting',
  )!,
  enabled: true,
  id: 'pull',
  path: '.atlas/automations/Pull actions.md',
} as AutomationRule;
const PORTS = { index: fakeIndexPort([]), types: [], notePaths: [] } as unknown as Parameters<
  typeof useAutomationEditor
>[0]['ports'];

const listed = (rule: AutomationRule) =>
  ({
    listing: { automations: [{ rule, log: [], ledger: null }], broken: [] },
  }) as unknown as AutomationsController;

async function openEditor() {
  const hook = renderHook(
    ({ automations }: { automations: AutomationsController }) =>
      useAutomationEditor({
        automations,
        ports: PORTS,
        clock: CLOCK,
        indexKey: 'k',
        activity: recordingActivity(),
      }),
    { initialProps: { automations: listed(RULE) }, wrapper: queryWrapper().wrapper },
  );
  await act(async () => hook.result.current.openRule(RULE));
  return hook;
}

describe('the editor open on a rule switched on or off since (#793)', () => {
  it('takes the rule’s on or off as listed again, and keeps the person’s other edits', async () => {
    const { result, rerender } = await openEditor();
    await act(async () => result.current.change({ ...RULE, name: 'Meeting actions, renamed' }));

    await act(async () => rerender({ automations: listed({ ...RULE, enabled: false }) }));

    const editing = result.current.editing;
    expect(editing?.kind === 'rule' && editing.rule.enabled).toBe(false);
    expect(editing?.draft).toMatchObject({ enabled: false, name: 'Meeting actions, renamed' });
  });

  it('keeps the on or off the person changed in the editor', async () => {
    const { result, rerender } = await openEditor();
    await act(async () => result.current.change({ ...RULE, enabled: false }));

    await act(async () => rerender({ automations: listed({ ...RULE, enabled: false }) }));
    await act(async () => rerender({ automations: listed({ ...RULE, enabled: true }) }));

    expect(result.current.editing?.draft.enabled).toBe(false);
  });
});
