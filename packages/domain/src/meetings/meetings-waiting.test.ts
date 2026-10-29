import { describe, expect, it } from 'vitest';
import type { PullStanding } from '../sync/pull-freshness.ts';
import {
  meetingsWaitingLine,
  meetingsWaitingReport,
  waitingCountGate,
  waitingMacLabel,
  waitingMeetingCount,
  waitsForImport,
  type CountableStanding,
  type WaitingMeetingFile,
} from './meetings-waiting.ts';

const PULLED: CountableStanding = {
  kind: 'pulled',
  startedAsleepMs: 5_000,
  finishedAt: 1_000_000,
  namedAfter: false,
};
const BEFORE_PULL = 900_000;
const AFTER_PULL = 1_100_000;

function file(
  path: string,
  read: Partial<NonNullable<WaitingMeetingFile['read']>> | null = {},
): WaitingMeetingFile {
  return {
    path,
    read:
      read === null
        ? null
        : { importDeclared: true, importOutcome: null, modifiedAt: BEFORE_PULL, ...read },
  };
}

const UNSTAMPED = file('Inbox/Meetings/2026-10-27 Larkspur weekly.md');
const STAMPED = file('Inbox/Meetings/2026-10-26 Vendor call.md', { importOutcome: 'imported' });
const CONFLICT = file('Inbox/Meetings/2026-10-27 Larkspur weekly (conflict from Studio).md');
const UNREADABLE = file('Inbox/Meetings/2026-10-25 Quarterly review.md', null);

describe('waitsForImport', () => {
  it('counts a meeting file with no import stamp', () => {
    expect(waitsForImport(UNSTAMPED, PULLED)).toBe(true);
  });

  it('never counts a stamped one, whatever the stamp says', () => {
    expect(waitsForImport(STAMPED, PULLED)).toBe(false);
    expect(
      waitsForImport(file('Inbox/Meetings/a.md', { importOutcome: 'duplicate' }), PULLED),
    ).toBe(false);
    expect(waitsForImport(file('Inbox/Meetings/a.md', { importOutcome: 'error' }), PULLED)).toBe(
      false,
    );
  });

  it('never counts a sync-conflict copy, which a claim cannot clear', () => {
    expect(waitsForImport(CONFLICT, PULLED)).toBe(false);
  });

  it('never counts a file that cannot be read', () => {
    expect(waitsForImport(UNREADABLE, PULLED)).toBe(false);
  });

  it('counts a file only once a pull finished after it was modified here (gate 1)', () => {
    expect(waitsForImport(file('Inbox/Meetings/a.md', { modifiedAt: AFTER_PULL }), PULLED)).toBe(
      false,
    );
    expect(
      waitsForImport(file('Inbox/Meetings/a.md', { modifiedAt: PULLED.finishedAt }), PULLED),
    ).toBe(false);
  });

  it('counts what the import would judge: a hand-made note in a month folder is not a meeting arrival', () => {
    const handMade = file('Meetings/2026/10/Catch-up with Mara.md', { importDeclared: false });
    expect(waitsForImport(handMade, PULLED)).toBe(false);
    const declared = file('Meetings/2026/10/Catch-up with Mara.md');
    expect(waitsForImport(declared, PULLED)).toBe(true);
  });

  it('counts nothing outside where meetings land, the Archive included', () => {
    expect(waitsForImport(file('Inbox/Call Mara.md'), PULLED)).toBe(false);
    expect(waitsForImport(file('Archive/Inbox/Meetings/a.md'), PULLED)).toBe(false);
  });
});

describe('waitingMeetingCount', () => {
  it('counts the unstamped files alone in a mixed folder', () => {
    const second = file('Inbox/Meetings/2026-10-28 Platform sync.md');
    const late = file('Inbox/Meetings/2026-10-28 Late.md', { modifiedAt: AFTER_PULL });
    expect(
      waitingMeetingCount([UNSTAMPED, STAMPED, CONFLICT, UNREADABLE, second, late], PULLED),
    ).toBe(2);
  });

  it('is 0 for an empty folder', () => {
    expect(waitingMeetingCount([], PULLED)).toBe(0);
  });
});

describe('waitingCountGate', () => {
  const awake = { asleepNowMs: PULLED.startedAsleepMs, paused: false };

  it('opens after a pull that started since the Mac last slept, against that pull', () => {
    expect(waitingCountGate({ standing: PULLED, ...awake })).toEqual({
      open: true,
      standing: PULLED,
    });
  });

  it('gives no count before a pull completes, during one, or after the Mac slept', () => {
    const shut = { open: false, why: 'no-pull' };
    expect(waitingCountGate({ standing: null, ...awake })).toEqual(shut);
    expect(waitingCountGate({ standing: { kind: 'pulling' }, ...awake })).toEqual(shut);
    expect(waitingCountGate({ standing: PULLED, asleepNowMs: 65_000, paused: false })).toEqual(
      shut,
    );
    expect(waitingCountGate({ standing: PULLED, asleepNowMs: null, paused: false })).toEqual(shut);
  });

  it('says why when sync is paused, or the settings cannot be read', () => {
    expect(waitingCountGate({ standing: PULLED, ...awake, paused: true })).toEqual({
      open: false,
      why: 'paused',
    });
    const unreadable: PullStanding = { kind: 'settings-unreadable' };
    expect(waitingCountGate({ standing: unreadable, ...awake })).toEqual({
      open: false,
      why: 'settings-unreadable',
    });
  });

  it('gives none in a vault that does not sync: it has one Mac, and is unchanged', () => {
    const standing: PullStanding = { kind: 'not-synced' };
    expect(waitingCountGate({ standing, asleepNowMs: null, paused: false })).toEqual({
      open: false,
      why: 'not-synced',
    });
  });
});

describe('meetingsWaitingLine', () => {
  const mac = 'Studio';

  it('says nothing when none waits', () => {
    expect(meetingsWaitingLine({ kind: 'counted', mac, count: 0 })).toBeNull();
  });

  it('says one meeting, and N meetings, waiting for the Mac by name', () => {
    expect(meetingsWaitingLine({ kind: 'counted', mac, count: 1 })).toBe(
      '1 meeting waiting for Studio',
    );
    expect(meetingsWaitingLine({ kind: 'counted', mac, count: 28 })).toBe(
      '28 meetings waiting for Studio',
    );
  });

  it('before a count can be given, says what it waits for and no number', () => {
    const noPull = meetingsWaitingLine({ kind: 'uncounted', mac, why: 'no-pull' });
    expect(noPull).toBe(
      'Meetings may be waiting for Studio: they are counted after the next sync.',
    );
    const paused = meetingsWaitingLine({ kind: 'uncounted', mac, why: 'paused' });
    expect(paused).toBe('Meetings may be waiting for Studio: they are counted once sync resumes.');
    expect(noPull).not.toMatch(/\d/);
    expect(paused).not.toMatch(/\d/);
  });

  it('says nothing while the settings cannot be read: which Mac is named is not known', () => {
    expect(meetingsWaitingLine({ kind: 'uncounted', mac, why: 'settings-unreadable' })).toBeNull();
  });

  it('says nothing in a vault that does not sync', () => {
    expect(meetingsWaitingLine({ kind: 'uncounted', mac, why: 'not-synced' })).toBeNull();
  });
});

describe('meetingsWaitingReport', () => {
  it('is a meeting warning naming the count and the Mac', () => {
    expect(meetingsWaitingReport({ count: 3, mac: 'Studio' })).toEqual({
      level: 'warning',
      kind: 'meeting',
      message: '3 meetings are waiting for Studio to process them.',
      subject: null,
    });
    expect(meetingsWaitingReport({ count: 1, mac: 'Studio' })?.message).toBe(
      '1 meeting is waiting for Studio to process it.',
    );
  });

  it('is nothing when none waits', () => {
    expect(meetingsWaitingReport({ count: 0, mac: 'Studio' })).toBeNull();
  });
});

describe('waitingMacLabel', () => {
  it('is the name the settings keep, trimmed', () => {
    expect(waitingMacLabel('  Studio ')).toBe('Studio');
  });

  it('never falls back to an id: an unnamed Mac is described', () => {
    expect(waitingMacLabel(null)).toBe('the Mac that runs the automations');
    expect(waitingMacLabel('   ')).toBe('the Mac that runs the automations');
  });
});
