import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  ASLEEP_READING_SLACK_MS,
  freshPullVerdict,
  freshPullWaitReport,
  gatedByFreshPull,
  pullEndEffect,
  pulledAfterArrival,
  pulledSinceLastSleep,
  standingAfterPull,
  type FreshPullShut,
  type PullStanding,
} from './pull-freshness.ts';

/**
 * A fake of the host's counter (#172): the time asleep since boot, which a
 * test moves only by "sleeping" the Mac. The wall clock is not in it at all.
 */
function fakeMac(asleepMs = 457_335_000) {
  let asleep = asleepMs;
  return {
    read: () => asleep,
    sleep: (ms: number) => {
      asleep += ms;
    },
  };
}

const FINISHED_AT = 1_760_000_000_000;

function pulled(startedAsleepMs: number, changes: Partial<PullStanding> = {}): PullStanding {
  return { kind: 'pulled', startedAsleepMs, finishedAt: FINISHED_AT, namedAfter: true, ...changes };
}

describe('pulledSinceLastSleep (gate 2, ADR-0035 part 4)', () => {
  it('is false at launch, before any pull has completed', () => {
    const mac = fakeMac();
    expect(pulledSinceLastSleep({ standing: null, asleepNowMs: mac.read() })).toBe(false);
  });

  it('is true once a pull started and completed with the Mac awake throughout', () => {
    const mac = fakeMac();
    const standing = pulled(mac.read());
    expect(pulledSinceLastSleep({ standing, asleepNowMs: mac.read() })).toBe(true);
  });

  it('is false after the Mac sleeps, however long ago the pull was', () => {
    const mac = fakeMac();
    const standing = pulled(mac.read());
    mac.sleep(8 * 60 * 60 * 1000);
    expect(pulledSinceLastSleep({ standing, asleepNowMs: mac.read() })).toBe(false);
  });

  it('is false after a dark wake, which the did-wake notification never reports', () => {
    const mac = fakeMac();
    const standing = pulled(mac.read());
    mac.sleep(991_000);
    expect(pulledSinceLastSleep({ standing, asleepNowMs: mac.read() })).toBe(false);
  });

  it('does not count a pull that started before a sleep and completed after it', () => {
    const mac = fakeMac();
    const straddling = pulled(mac.read());
    mac.sleep(60_000);
    expect(pulledSinceLastSleep({ standing: straddling, asleepNowMs: mac.read() })).toBe(false);
  });

  it('is true again once a pull started after the wake has completed', () => {
    const mac = fakeMac();
    mac.sleep(60_000);
    const afterWake = pulled(mac.read());
    expect(pulledSinceLastSleep({ standing: afterWake, asleepNowMs: mac.read() })).toBe(true);
  });

  it('is false when the host could not read the counter: it never guesses', () => {
    const mac = fakeMac();
    expect(pulledSinceLastSleep({ standing: pulled(mac.read()), asleepNowMs: null })).toBe(false);
    // Not read as zero either: a Mac that has not slept since it booted reads zero.
    expect(pulledSinceLastSleep({ standing: pulled(0), asleepNowMs: null })).toBe(false);
  });

  it('is false while a pull is under way: what it brings is judged once it completes', () => {
    const mac = fakeMac();
    expect(pulledSinceLastSleep({ standing: { kind: 'pulling' }, asleepNowMs: mac.read() })).toBe(
      false,
    );
  });

  it('is true for a vault that does not sync, whatever the counter says', () => {
    expect(pulledSinceLastSleep({ standing: { kind: 'not-synced' }, asleepNowMs: null })).toBe(
      true,
    );
  });

  // Two reads of one awake spell differ only by the moment between the host's
  // two clock reads, which rounding can show as a millisecond or a preempted
  // thread as a few more; no real sleep is that short.
  it('takes two readings within the slack as one awake spell, and one past it as a sleep', () => {
    const started = 457_335_000;
    const within = [started + 1, started - 1, started + ASLEEP_READING_SLACK_MS];
    for (const asleepNowMs of within) {
      expect(pulledSinceLastSleep({ standing: pulled(started), asleepNowMs })).toBe(true);
    }
    const past = [started + ASLEEP_READING_SLACK_MS + 1, started - ASLEEP_READING_SLACK_MS - 1];
    for (const asleepNowMs of past) {
      expect(pulledSinceLastSleep({ standing: pulled(started), asleepNowMs })).toBe(false);
    }
  });

  it('is false on a reading that is not a number of milliseconds', () => {
    for (const asleepNowMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pulledSinceLastSleep({ standing: pulled(457_335_000), asleepNowMs })).toBe(false);
    }
  });
});

describe('pulledAfterArrival (gate 1, ADR-0035 part 4)', () => {
  it('is true for a file that was there before the pull completed', () => {
    const standing = pulled(0);
    expect(pulledAfterArrival({ standing, modifiedAt: FINISHED_AT - 1 })).toBe(true);
  });

  it('is false for a file that arrived as or after the pull completed', () => {
    const standing = pulled(0);
    expect(pulledAfterArrival({ standing, modifiedAt: FINISHED_AT })).toBe(false);
    expect(pulledAfterArrival({ standing, modifiedAt: FINISHED_AT + 1 })).toBe(false);
  });

  it('is false with no completed pull, or one under way', () => {
    expect(pulledAfterArrival({ standing: null, modifiedAt: 0 })).toBe(false);
    expect(pulledAfterArrival({ standing: { kind: 'pulling' }, modifiedAt: 0 })).toBe(false);
  });

  it('is true for a vault that does not sync', () => {
    expect(pulledAfterArrival({ standing: { kind: 'not-synced' }, modifiedAt: FINISHED_AT })).toBe(
      true,
    );
  });
});

describe('pullEndEffect: what a run of git leaves the session knowing (ADR-0035 part 4)', () => {
  it('a sync that completes completes a pull', () => {
    expect(pullEndEffect({ kind: 'synced' })).toBe('completes');
  });

  it('a look that finds nothing to bring in completes a pull: the files hold what GitHub had', () => {
    expect(pullEndEffect({ kind: 'looked', behind: 0 })).toBe('completes');
  });

  it('a look that finds other Macs’ changes voids what was known, however few', () => {
    expect(pullEndEffect({ kind: 'looked', behind: 1 })).toBe('voids');
    expect(pullEndEffect({ kind: 'looked', behind: 40 })).toBe('voids');
  });

  it('a sync that fails voids what was known: it may have brought files in first', () => {
    expect(pullEndEffect({ kind: 'sync-failed' })).toBe('voids');
  });

  it('a look that fails changed no file, and keeps what was known', () => {
    expect(pullEndEffect({ kind: 'look-failed' })).toBe('keeps');
  });
});

describe('standingAfterPull', () => {
  it('records the counter as the pull started, when it finished, and whether the settings it left name this Mac', () => {
    expect(
      standingAfterPull({
        startedAsleepMs: 5,
        finishedAt: FINISHED_AT,
        settings: 'names-this-mac',
      }),
    ).toEqual({ kind: 'pulled', startedAsleepMs: 5, finishedAt: FINISHED_AT, namedAfter: true });
    expect(
      standingAfterPull({
        startedAsleepMs: 5,
        finishedAt: FINISHED_AT,
        settings: 'names-another-mac',
      }),
    ).toMatchObject({ kind: 'pulled', namedAfter: false });
  });

  it('counts for nothing a pull whose start could not be placed against a sleep', () => {
    expect(
      standingAfterPull({
        startedAsleepMs: null,
        finishedAt: FINISHED_AT,
        settings: 'names-this-mac',
      }),
    ).toBeNull();
  });

  it('is settings-unreadable when the settings it left cannot be read: not the same as naming no Mac', () => {
    expect(
      standingAfterPull({ startedAsleepMs: 0, finishedAt: FINISHED_AT, settings: 'unreadable' }),
    ).toEqual({ kind: 'settings-unreadable' });
  });
});

describe('freshPullVerdict: the gates the import and the Claude step pass (ADR-0035 part 4)', () => {
  const awake = 457_335_000;
  /** Every gate open: a fresh pull, named after it and now, sync running, nothing modified since. */
  const open: Parameters<typeof freshPullVerdict>[0] = {
    standing: pulled(awake),
    asleepNowMs: awake,
    settingsNow: 'names-this-mac',
    paused: false,
    arrivedAt: FINISHED_AT - 1,
  };
  const cases: {
    name: string;
    facts: Partial<typeof open> & object;
    shut: FreshPullShut | null;
  }[] = [
    { name: 'every gate open', facts: {}, shut: null },
    { name: 'a step on no one file', facts: { arrivedAt: null }, shut: null },
    { name: 'no pull yet this session', facts: { standing: null }, shut: 'no-pull' },
    { name: 'a pull under way', facts: { standing: { kind: 'pulling' } }, shut: 'pulling' },
    {
      name: 'the settings the pull brought name another Mac',
      facts: { standing: pulled(awake, { namedAfter: false }) },
      shut: 'not-named',
    },
    {
      name: 'the settings now name another Mac',
      facts: { settingsNow: 'names-another-mac' },
      shut: 'not-named',
    },
    {
      name: 'the settings cannot be read now',
      facts: { settingsNow: 'unreadable' },
      shut: 'settings-unreadable',
    },
    {
      name: 'the settings the pull left cannot be read',
      facts: { standing: { kind: 'settings-unreadable' } },
      shut: 'settings-unreadable',
    },
    { name: 'sync paused on this Mac', facts: { paused: true }, shut: 'paused' },
    {
      name: 'slept since the pull started',
      facts: { asleepNowMs: awake + 60_000 },
      shut: 'slept',
    },
    { name: 'the counter cannot be read', facts: { asleepNowMs: null }, shut: 'slept' },
    {
      name: 'the file was modified here as the pull completed',
      facts: { arrivedAt: FINISHED_AT },
      shut: 'arrived-after-pull',
    },
    {
      name: 'the file was modified here after the pull completed',
      facts: { arrivedAt: FINISHED_AT + 5_000 },
      shut: 'arrived-after-pull',
    },
    {
      name: 'a vault that does not sync, named',
      facts: { standing: { kind: 'not-synced' }, asleepNowMs: null, arrivedAt: FINISHED_AT * 2 },
      shut: null,
    },
    {
      name: 'a vault that does not sync, whatever the pause switch held for it',
      facts: { standing: { kind: 'not-synced' }, paused: true },
      shut: null,
    },
    {
      name: 'a vault that does not sync, its settings naming another Mac',
      facts: { standing: { kind: 'not-synced' }, settingsNow: 'names-another-mac' },
      shut: 'not-named',
    },
    {
      name: 'a vault that does not sync, its settings unreadable',
      facts: { standing: { kind: 'not-synced' }, settingsNow: 'unreadable' },
      shut: 'settings-unreadable',
    },
  ];

  for (const { name, facts, shut } of cases) {
    it(`${shut === null ? 'is open' : `is shut (${shut})`}: ${name}`, () => {
      expect(freshPullVerdict({ ...open, ...facts })).toEqual(
        shut === null ? { open: true } : { open: false, shut },
      );
    });
  }

  it('says paused before waiting for a pull: a paused Mac pulls nothing, so the pause is what to undo', () => {
    expect(freshPullVerdict({ ...open, standing: null, paused: true })).toEqual({
      open: false,
      shut: 'paused',
    });
  });

  it('takes settings that were not read as unreadable, wherever they would count', () => {
    expect(freshPullVerdict({ ...open, settingsNow: null })).toEqual({
      open: false,
      shut: 'settings-unreadable',
    });
    expect(
      freshPullVerdict({ ...open, standing: { kind: 'not-synced' }, settingsNow: null }),
    ).toEqual({ open: false, shut: 'settings-unreadable' });
  });

  it('needs no settings while the standing shuts the gates by itself', () => {
    expect(freshPullVerdict({ ...open, standing: null, settingsNow: null })).toEqual({
      open: false,
      shut: 'no-pull',
    });
  });

  it('runs nothing on a Mac another claimed while it slept: it wakes, pulls, and is not named', () => {
    const laptop = fakeMac();
    const facts = { ...open, arrivedAt: null };
    // The laptop was named and pulled before it slept.
    const beforeSleep = pulled(laptop.read());
    expect(
      freshPullVerdict({ ...facts, standing: beforeSleep, asleepNowMs: laptop.read() }),
    ).toEqual({ open: true });
    // The studio claims while it sleeps; it wakes still holding the old settings.
    laptop.sleep(20 * 60_000);
    expect(
      freshPullVerdict({ ...facts, standing: beforeSleep, asleepNowMs: laptop.read() }).open,
    ).toBe(false);
    // The pull after the wake brings the claim in.
    const afterWake = pulled(laptop.read(), { namedAfter: false });
    expect(freshPullVerdict({ ...facts, standing: afterWake, asleepNowMs: laptop.read() })).toEqual(
      { open: false, shut: 'not-named' },
    );
  });
});

describe('freshPullVerdict: a claim not yet shared (#630 review)', () => {
  const awake = 457_335_000;
  const open: Parameters<typeof freshPullVerdict>[0] = {
    standing: pulled(awake),
    asleepNowMs: awake,
    settingsNow: 'names-this-mac',
    paused: false,
    arrivedAt: FINISHED_AT - 1,
  };

  it('stays shut while this Mac’s claim has not reached GitHub, though a pull named it', () => {
    expect(freshPullVerdict({ ...open, claimUnshared: true })).toEqual({
      open: false,
      shut: 'claim-unshared',
    });
  });

  it('opens once it has', () => {
    expect(freshPullVerdict({ ...open, claimUnshared: false })).toEqual({ open: true });
  });

  it('says paused first: resuming is what shares it', () => {
    expect(freshPullVerdict({ ...open, paused: true, claimUnshared: true })).toEqual({
      open: false,
      shut: 'paused',
    });
  });
});

describe('gatedByFreshPull: which rules wait on the gates', () => {
  const claude = {
    action: {
      kind: 'claude' as const,
      prompt: createVaultPath('.atlas/prompts/actions.md'),
      tools: [],
      output: { kind: 'proposals' as const, schema: 'proposals' },
    },
  };

  it('gates a Claude step whatever sets it off but the person', () => {
    for (const trigger of ['note', 'schedule', 'open'] as const) {
      expect(gatedByFreshPull({ rule: claude, trigger })).toBe(true);
    }
    expect(gatedByFreshPull({ rule: claude, trigger: 'hand' })).toBe(false);
  });

  it('never gates a rule that only sets values or archives: it is the same on any Mac', () => {
    for (const trigger of ['note', 'schedule', 'open', 'hand'] as const) {
      expect(gatedByFreshPull({ rule: { action: { kind: 'archive' } }, trigger })).toBe(false);
      expect(gatedByFreshPull({ rule: { action: { kind: 'set', values: {} } }, trigger })).toBe(
        false,
      );
    }
  });
});

describe('freshPullWaitReport', () => {
  it('says automations wait while sync is paused', () => {
    expect(freshPullWaitReport('paused')).toMatchObject({
      kind: 'sync',
      message: expect.stringMatching(/paused on this Mac, so automations wait/),
    });
  });

  it('warns that nothing runs while the settings cannot be read', () => {
    expect(freshPullWaitReport('settings-unreadable')).toMatchObject({
      level: 'warning',
      message: expect.stringMatching(/cannot be read, so nothing runs/),
    });
  });

  it('says nothing of a wait that passes by itself', () => {
    const passing: FreshPullShut[] = [
      'no-pull',
      'pulling',
      'slept',
      'arrived-after-pull',
      'not-named',
    ];
    for (const why of passing) expect(freshPullWaitReport(why)).toBeNull();
  });
});
