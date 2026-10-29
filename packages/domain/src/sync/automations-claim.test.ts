import { describe, expect, it } from 'vitest';
import {
  claimedSettings,
  claimProblem,
  claimRefusal,
  claimRefusalLine,
  claimReport,
  namesThisMac,
  syncFailing,
  type ClaimOutcome,
  type ClaimRefusal,
} from './automations-claim.ts';
import type { PullStanding } from './pull-freshness.ts';
import { mergeSettingsText, writtenMap, type SettingsText } from './settings-merge.ts';
import type { SyncPhase } from './sync-state.ts';

const PULLED: PullStanding = {
  kind: 'pulled',
  startedAsleepMs: 5_000,
  finishedAt: 100,
  namedAfter: false,
};
const SYNCED: SyncPhase = { kind: 'ready' };
const FAILED: SyncPhase = { kind: 'failed', reason: 'offline', at: 1 };
const MAC = { id: 'mac-laptop', name: 'Laptop' };

const healthy: {
  standing: PullStanding | null;
  asleepNowMs: number | null;
  paused: boolean;
  phase: SyncPhase;
} = { standing: PULLED, asleepNowMs: 5_000, paused: false, phase: SYNCED };

describe('claimRefusal: when "Process here" may claim (ADR-0035 part 2)', () => {
  it('lets a healthy Mac claim: a pull since launch or wake has completed, sync neither paused nor failing', () => {
    expect(claimRefusal(healthy)).toBeNull();
  });

  it.each<[string, Partial<typeof healthy>, ClaimRefusal]>([
    ['paused', { paused: true }, 'paused'],
    ['failing', { phase: FAILED }, 'failing'],
    ['no pull since launch', { standing: null }, 'no-pull'],
    ['slept since the pull', { asleepNowMs: 5_000 + 60_000 }, 'no-pull'],
    ['the sleep counter unreadable', { asleepNowMs: null }, 'no-pull'],
    ['a pull under way', { standing: { kind: 'pulling' } }, 'pulling'],
    [
      'settings the pull left unreadable',
      { standing: { kind: 'settings-unreadable' } },
      'settings-unreadable',
    ],
    ['a vault that does not sync', { standing: { kind: 'not-synced' } }, 'not-synced'],
  ])('refuses %s', (_, change, why) => {
    expect(claimRefusal({ ...healthy, ...change })).toBe(why);
  });

  it('says paused before failing, and failing before a pull it waits for', () => {
    expect(claimRefusal({ ...healthy, paused: true, phase: FAILED, standing: null })).toBe(
      'paused',
    );
    expect(claimRefusal({ ...healthy, phase: FAILED, standing: null })).toBe('failing');
  });

  it('allows a reading within the slack of one awake spell', () => {
    expect(claimRefusal({ ...healthy, asleepNowMs: 5_000 + 900 })).toBeNull();
  });

  it('counts only a failed sync or look as failing', () => {
    expect(syncFailing(FAILED)).toBe(true);
    expect(syncFailing({ kind: 'syncing' })).toBe(false);
    expect(syncFailing({ kind: 'refused', reason: 'inside another repository' })).toBe(false);
  });
});

describe('the claim’s settings, and who they name', () => {
  it('writes this Mac’s id, which decides, and its name, to show', () => {
    expect(claimedSettings({ id: ' mac-laptop ', name: 'Laptop' })).toEqual({
      automationsMac: 'mac-laptop',
      automationsMacName: 'Laptop',
    });
  });

  it('compares ids, never names: a Mac renamed since is still the one named', () => {
    expect(namesThisMac('mac-laptop', { id: 'mac-laptop' })).toBe(true);
    expect(namesThisMac(' mac-laptop ', { id: 'mac-laptop' })).toBe(true);
    expect(namesThisMac('mac-studio', { id: 'mac-laptop' })).toBe(false);
    expect(namesThisMac('Laptop', { id: 'mac-laptop' })).toBe(false);
  });

  it('does not take settings that name no Mac for this one', () => {
    expect(namesThisMac(null, { id: 'mac-laptop' })).toBe(false);
    expect(namesThisMac('', { id: 'mac-laptop' })).toBe(false);
    expect(namesThisMac(7, { id: 'mac-laptop' })).toBe(false);
  });
});

describe('what the banner and Activity say of a claim', () => {
  it.each<ClaimRefusal>([
    'paused',
    'failing',
    'no-pull',
    'pulling',
    'settings-unreadable',
    'not-synced',
  ])('says which reason refuses it: %s', (why) => {
    expect(claimRefusalLine(why)).not.toBe('');
    expect(claimProblem({ kind: 'refused', why })).toBe(claimRefusalLine(why));
  });

  it('tells paused, failing and waiting for a pull apart', () => {
    expect(claimRefusalLine('paused')).toMatch(/paused/);
    expect(claimRefusalLine('failing')).toMatch(/failing/);
    expect(claimRefusalLine('no-pull')).toMatch(/after the next sync/);
    expect(claimRefusalLine('pulling')).toBe(claimRefusalLine('no-pull'));
  });

  it('says nothing for a claim that named this Mac, or found it named, or whose vault closed', () => {
    for (const kind of ['claimed', 'already-named', 'vault-closed'] as const) {
      expect(claimProblem({ kind })).toBeNull();
    }
  });

  it('says that unreadable settings changed nothing, and why a write failed', () => {
    expect(claimProblem({ kind: 'unreadable' })).toMatch(/cannot be read, so nothing was changed/);
    expect(claimProblem({ kind: 'write-failed', reason: 'disk full' })).toMatch(/disk full$/);
  });

  it('records the claim in Activity, and a failed write as a warning', () => {
    expect(claimReport({ kind: 'claimed' }, MAC)).toEqual({
      level: 'info',
      kind: 'sync',
      message:
        'Laptop now runs the automations: meetings that waited are processed here after the next sync.',
      subject: null,
    });
    expect(claimReport({ kind: 'write-failed', reason: 'disk full' }, MAC)).toMatchObject({
      level: 'warning',
      message: expect.stringMatching(/disk full$/) as string,
    });
  });

  it('records nothing for the rest', () => {
    const quiet: ClaimOutcome[] = [
      { kind: 'already-named' },
      { kind: 'refused', why: 'paused' },
      { kind: 'unreadable' },
      { kind: 'vault-closed' },
    ];
    for (const outcome of quiet) expect(claimReport(outcome, MAC)).toBeNull();
  });
});

describe('two Macs that claim within one sync interval (ADR-0025 conflict rule, #176)', () => {
  const settingsOf = (mac: { id: string; name: string } | null): SettingsText => {
    const lines = [
      'sync: github\n',
      ...(mac === null ? [] : [`automationsMac: ${mac.id}\n`, `automationsMacName: ${mac.name}\n`]),
    ];
    return {
      keys: lines.map((text) => ({
        key: text.slice(0, text.indexOf(':')),
        text,
        map: writtenMap(text),
      })),
      body: '',
    };
  };
  const BASE = settingsOf({ id: 'mac-studio', name: 'Studio' });
  const LAPTOP = settingsOf({ id: 'mac-laptop', name: 'Laptop' });
  const DESK = settingsOf({ id: 'mac-desk', name: 'Desk' });

  it('is never merged by its keys: the Mac whose sync merges keeps its own claim, and the other’s is copied aside', () => {
    expect(mergeSettingsText({ base: BASE, onto: LAPTOP, from: DESK })).toBeNull();
    expect(mergeSettingsText({ base: BASE, onto: DESK, from: LAPTOP })).toBeNull();
  });

  it('survives a setting the other Mac only added meanwhile: the claim and the setting are both kept', () => {
    const interval = 'syncInterval: 15\n';
    const timed: SettingsText = {
      ...BASE,
      keys: [...BASE.keys, { key: 'syncInterval', text: interval, map: writtenMap(interval) }],
    };
    // Laptop's sync merges, or the other's does: git's two sides are tried both ways round.
    const merged = mergeSettingsText({ base: BASE, onto: LAPTOP, from: timed });
    expect(merged?.frontmatter).toContain('automationsMac: mac-laptop\n');
    expect(merged?.frontmatter).toContain(interval);
    expect(mergeSettingsText({ base: BASE, onto: timed, from: LAPTOP })).toBeNull();
  });
});
