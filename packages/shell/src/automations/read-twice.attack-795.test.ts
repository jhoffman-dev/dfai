/**
 * Attack on PR #795 (#793): the read-twice offer's "Turn off" click. Each
 * `it.fails` is a bug found; the fix flips it to `it`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AFTER_A_MEETING_PRESET,
  AUTOMATION_PRESETS,
  meetingsReadTwice,
  type AutomationRule,
} from '@dfai/domain';
import type { AutomationsController } from './automations-store.ts';
import { turnOffRule } from './read-twice.ts';

const EXTRACTION = AUTOMATION_PRESETS.find(
  (preset) => preset.name === 'Pull actions and decisions out of a new meeting',
)!;

function controller(rules: readonly AutomationRule[]) {
  const setEnabled = vi.fn(async () => null);
  const automations = {
    listing: { automations: rules.map((rule) => ({ rule, log: [] })), broken: [] },
    setEnabled,
  } as unknown as AutomationsController;
  return { automations, setEnabled };
}

describe('turning off the rule that reads every meeting twice (#793 attack)', () => {
  // A rule's name is its frontmatter `name` (automation-rule.ts readDraft), which nothing keeps unique
  // across files: the offer finds its rule by name (read-twice.ts turnOffRule), so with the declared
  // step first under the same name it turns "After a meeting" off and every meeting goes unprocessed.
  it.fails(
    'turns off the extraction rule, never the declared step that shares its name',
    async () => {
      const declared = {
        ...AFTER_A_MEETING_PRESET,
        name: 'Meeting actions',
        id: 'after',
        path: '.atlas/automations/After a meeting.md',
      } as AutomationRule;
      const extraction = {
        ...EXTRACTION,
        name: 'Meeting actions',
        id: 'pull',
        path: '.atlas/automations/Pull actions.md',
      } as AutomationRule;
      const [named] = meetingsReadTwice([declared, extraction]);
      expect(named).toBe(extraction);
      const { automations, setEnabled } = controller([declared, extraction]);

      await turnOffRule(automations, named!.name);

      expect(setEnabled).toHaveBeenCalledTimes(1);
      expect(setEnabled).toHaveBeenCalledWith(extraction, false);
    },
  );
});
