import { describe, expect, it } from 'vitest';
import { automationsScheduled } from './automations-scheduled.ts';

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
