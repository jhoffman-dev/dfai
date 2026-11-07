import { describe, expect, it, vi } from 'vitest';
import { AFTER_A_MEETING_PRESET, type AutomationRule } from '@dfai/domain';
import type { AutomationsController } from './automations-store.ts';
import { readTwiceViews, turnOffRule } from './read-twice.ts';

const RULE = { ...AFTER_A_MEETING_PRESET, name: 'Meeting actions', id: 'm', path: 'm.md' };

function controller(rules: readonly AutomationRule[]) {
  const setEnabled = vi.fn(async () => null);
  const automations = {
    listing: { automations: rules.map((rule) => ({ rule, log: [] })), broken: [] },
    setEnabled,
  } as unknown as AutomationsController;
  return { automations, setEnabled };
}

describe('turnOffRule (#793)', () => {
  it('turns the named rule off, as its toggle does', async () => {
    const { automations, setEnabled } = controller([RULE as AutomationRule]);
    expect(await turnOffRule(automations, 'Meeting actions')).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith(RULE, false);
  });

  it('turns nothing off when no rule read has the name, or the rules are not read', async () => {
    const { automations, setEnabled } = controller([RULE as AutomationRule]);
    expect(await turnOffRule(automations, 'Another')).toBe(false);
    expect(await turnOffRule(null, 'Meeting actions')).toBe(false);
    expect(setEnabled).not.toHaveBeenCalled();
  });
});

describe('readTwiceViews', () => {
  it('says of each rule that every meeting is read twice', () => {
    const [view] = readTwiceViews(['Meeting actions']);
    expect(view?.rule).toBe('Meeting actions');
    expect(view?.warning).toContain('“After a meeting” and “Meeting actions”');
  });
});
