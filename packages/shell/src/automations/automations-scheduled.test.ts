import { describe, expect, it } from 'vitest';
import { automationsScheduled, switchedScheduled } from './automations-scheduled.ts';

describe('automationsScheduled', () => {
  it('holds every rule while the owner’s name and addresses are not read yet (#173)', () => {
    expect(automationsScheduled({ automationsHere: true, macKnown: true, ownerKnown: false })).toBe(
      null,
    );
  });

  it('holds every rule while this Mac is not known yet', () => {
    expect(automationsScheduled({ automationsHere: true, macKnown: false, ownerKnown: true })).toBe(
      null,
    );
  });

  it('runs rules here once both are known, on the Mac named for them only', () => {
    expect(automationsScheduled({ automationsHere: true, macKnown: true, ownerKnown: true })).toBe(
      true,
    );
    expect(automationsScheduled({ automationsHere: false, macKnown: true, ownerKnown: true })).toBe(
      false,
    );
  });
});

describe('switchedScheduled: the Automations switch (#901)', () => {
  it.each([true, false, null])('follows this Mac (%s) while Automations is on', (scheduled) => {
    expect(switchedScheduled({ enabled: true, featuresKnown: true, scheduled })).toBe(scheduled);
  });

  it('sets off no rule once the settings say Automations is off, on the named Mac too', () => {
    for (const scheduled of [true, false, null]) {
      expect(switchedScheduled({ enabled: false, featuresKnown: true, scheduled })).toBe(false);
    }
  });

  it('holds, rather than lets go, while the settings are unread', () => {
    expect(switchedScheduled({ enabled: false, featuresKnown: false, scheduled: true })).toBe(null);
  });
});
