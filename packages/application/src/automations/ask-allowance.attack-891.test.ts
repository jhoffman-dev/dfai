/**
 * Adversarial test for #813 (PR #891): the held rule's advice to turn off a
 * rule that shares its asks must name only a rule that is on.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PRESETS,
  DECLARED_STEP_MODEL,
  claudeStepBudget,
  logPathFor,
  newLogText,
  noteRunsHold,
  noteRunsHoldMessage,
  type AutomationDraft,
  type LogEntry,
} from '@dfai/domain';
import { automationVault } from '../testing/automation-vault.ts';
import { allowanceSharers } from './ask-allowance.ts';
import { loadAutomations } from './load-automations.ts';
import { createAutomation } from './save-automation.ts';

const TODAY = '2026-10-14';
const NOW = `${TODAY}T09:00:00`;
const CLOCK = { today: () => TODAY, localNow: () => NOW, now: () => Date.parse(`${NOW}Z`) };

const asks = (count: number): LogEntry[] =>
  Array.from({ length: count }, (_, at) => ({
    kind: 'run',
    at: `${TODAY}T08:${String(10 + at).padStart(2, '0')}:00`,
    trigger: 'note',
    done: [],
    left: [],
    capped: false,
    claude: { model: DECLARED_STEP_MODEL, ms: 10, asks: 1 },
  }));

const preset = (): AutomationDraft =>
  AUTOMATION_PRESETS.find((each) => each.name === 'After a meeting')!;

describe('the held rule’s turn-off advice (#813)', () => {
  it('does not offer to turn off a sharer that is already off', async () => {
    const vault = automationVault({ today: TODAY, notes: {} });
    const { fs, markdown } = vault.ports;
    await createAutomation({ fs, markdown, clock: CLOCK, draft: preset(), takenPaths: [] });
    await createAutomation({
      fs,
      markdown,
      clock: CLOCK,
      draft: { ...preset(), name: 'After a client call', enabled: false },
      takenPaths: [...vault.files.keys()],
    });
    const { automations } = await loadAutomations({
      fs,
      markdown,
      notePaths: [...vault.files.keys()],
    });
    const held = automations.find((each) => each.rule.name === 'After a meeting')!.rule;
    const off = automations.find((each) => each.rule.name === 'After a client call')!.rule;
    expect(off.enabled).toBe(false);
    // It was on earlier in the hour, and spent 20 asks then; they still count.
    vault.files.set(logPathFor(off.id), newLogText(off.name, asks(20)));
    vault.files.set(logPathFor(held.id), newLogText(held.name, asks(10)));
    const reloaded = await loadAutomations({ fs, markdown, notePaths: [...vault.files.keys()] });
    const own = reloaded.automations.find((each) => each.rule.id === held.id)!.log;

    const sharers = await allowanceSharers(vault.ports, held);
    const hold = noteRunsHold({
      rule: held.name,
      entries: own,
      now: NOW,
      budget: claudeStepBudget(held.action),
      sharers,
    });
    expect(hold?.sharedAsks?.by.map(({ name }) => name)).toContain('After a client call');

    expect(noteRunsHoldMessage(hold!)).not.toContain('turn off “After a client call”');
  });
});
