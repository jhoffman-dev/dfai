import { describe, expect, it, vi } from 'vitest';
import { AFTER_A_MEETING_PRESET, type AutomationRule } from '@dfai/domain';
import type { AutomationsController } from './automations-store.ts';
import { readTwiceViews, turnOffRule } from './read-twice.ts';

const RULE = { ...AFTER_A_MEETING_PRESET, name: 'Meeting actions', id: 'm', path: 'm.md' };

/** `answer` is what its runner says: undefined once written, null when refused. */
function controller(rules: readonly AutomationRule[], answer: null | undefined) {
  const setEnabled = vi.fn(async () => answer);
  const automations = {
    listing: { automations: rules.map((rule) => ({ rule, log: [] })), broken: [] },
    setEnabled,
  } as unknown as AutomationsController;
  return { automations, setEnabled };
}

describe('turnOffRule (#793)', () => {
  it('turns the rule in that file off, as its toggle does', async () => {
    const { automations, setEnabled } = controller([RULE as AutomationRule], undefined);
    expect(await turnOffRule(automations, 'm.md')).toBeNull();
    expect(setEnabled).toHaveBeenCalledWith(RULE, false);
  });

  it('says so when its runner refused the write', async () => {
    const { automations } = controller([RULE as AutomationRule], null);
    expect(await turnOffRule(automations, 'm.md')).toContain(
      '“Meeting actions” was not turned off',
    );
  });

  it('turns nothing off, and says so, when no rule read is in that file, or the rules are not read', async () => {
    const { automations, setEnabled } = controller([RULE as AutomationRule], undefined);
    expect(await turnOffRule(automations, 'Meeting actions')).toContain('nothing was turned off');
    expect(await turnOffRule(null, 'm.md')).toContain('nothing was turned off');
    expect(setEnabled).not.toHaveBeenCalled();
  });
});

describe('readTwiceViews', () => {
  it('says of each rule that every meeting is read twice', () => {
    const [view] = readTwiceViews([{ path: 'm.md', name: 'Meeting actions', declared: 'Digest' }]);
    expect(view).toMatchObject({ id: 'm.md', rule: 'Meeting actions' });
    expect(view?.warning).toContain('“Digest” and “Meeting actions”');
  });
});
