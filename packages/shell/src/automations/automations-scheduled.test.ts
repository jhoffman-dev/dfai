import { describe, expect, it } from 'vitest';
import { WEB_CAPABILITIES, type AutomationDraft } from '@dfai/domain';
import { entryPointsOffered, EVERY_ENTRY_POINT, NEEDS_THE_DESKTOP_APP } from '@dfai/application';
import { automationsScheduled, switchedScheduled, turnOf } from './automations-scheduled.ts';

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

describe('turnOf: what a rule does when its turn comes (#920)', () => {
  const claudeRule = { action: { kind: 'claude' } } as Pick<AutomationDraft, 'action'>;
  const archiveRule = { action: { kind: 'archive' } } as Pick<AutomationDraft, 'action'>;
  const web = entryPointsOffered(WEB_CAPABILITIES);

  it('neither runs nor holds a rule set off by itself once this Mac stops running the rules', () => {
    for (const platform of [EVERY_ENTRY_POINT, web]) {
      expect(turnOf({ rule: claudeRule, platform, runsHere: false, byHand: false })).toEqual({
        kind: 'skip',
      });
    }
  });

  it('holds a Claude rule only where the platform has no Claude Code, whatever the switches', () => {
    expect(turnOf({ rule: claudeRule, platform: web, runsHere: true, byHand: false })).toEqual({
      kind: 'hold',
      reason: NEEDS_THE_DESKTOP_APP,
    });
    expect(
      turnOf({ rule: claudeRule, platform: EVERY_ENTRY_POINT, runsHere: true, byHand: false }),
    ).toEqual({ kind: 'run' });
  });

  it('runs a rule by hand on a Mac that does not run the rules, and holds it where it cannot run', () => {
    expect(turnOf({ rule: archiveRule, platform: web, runsHere: false, byHand: true })).toEqual({
      kind: 'run',
    });
    expect(turnOf({ rule: claudeRule, platform: web, runsHere: false, byHand: true })).toEqual({
      kind: 'hold',
      reason: NEEDS_THE_DESKTOP_APP,
    });
  });
});
