import { describe, expect, it } from 'vitest';
import type { PullStanding } from '@dfai/domain';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeSleepClock } from '../testing/fake-git.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { createFreshPullGate } from './fresh-pull-gate.ts';
import { withPrograms } from './git-steps.ts';
import { ProgramMissingError } from './ports.ts';

const VAULT = '/Users/j/Notes';
const THIS_MAC = 'mac-studio';
const NAMED = `---\nsync: github\nautomationsMac: ${THIS_MAC}\nautomationsMacName: Studio\n---\n`;

/**
 * The gate on a vault whose settings note the test can change, as a pull
 * would, and whose other notes were last modified when `modified` says. The
 * host's counter is faked; the wall clock is the test's.
 */
function gateOn({ settings = NAMED as string | null, paused = false } = {}) {
  const vault = {
    settings,
    paused,
    modified: new Map<string, number>(),
    timeUnknown: new Set<string>(),
    now: 1_000,
  };
  const sleep = fakeSleepClock();
  const activity = recordingActivity();
  const told: (PullStanding | null)[] = [];
  const woke: string[] = [];
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        if (path === '.atlas/settings.md') {
          return vault.settings === null
            ? []
            : [{ path, text: vault.settings, modified: 1, size: 1 }];
        }
        const modified = vault.modified.get(path);
        if (modified === undefined) return [];
        const modifiedAt = vault.timeUnknown.has(path) ? { modifiedAt: null } : {};
        return [{ path, text: '', modified, size: 1, ...modifiedAt }];
      }),
  });
  const gate = createFreshPullGate({
    ports: {
      sleepClock: sleep.port,
      fs,
      // Frontmatter with an unclosed list does not read, as YAML would not.
      markdown: {
        ...fakeMarkdown(),
        frontmatterProblem: (frontmatter) => (frontmatter?.includes('[') ? 'unclosed list' : null),
      },
      clock: { now: () => vault.now },
      activity,
      onGitHub: null,
    },
    here: { thisMacId: () => THIS_MAC, paused: () => vault.paused },
    onStanding: (_, standing) => void told.push(standing),
    onSlept: (sleeper) => void woke.push(sleeper),
  });
  gate.opened(VAULT);
  gate.inspected(VAULT, true);
  /** A sync or a look, started and ended with the Mac awake. */
  const runs = async (end: Parameters<typeof gate.ended>[1]) => {
    const startedAsleepMs = await gate.readAsleep();
    if (end.kind === 'synced' || end.kind === 'sync-failed') gate.started(VAULT);
    await gate.ended(VAULT, end, startedAsleepMs);
  };
  const said = () => activity.reports.map((report) => report.message);
  return { gate, vault, sleep, runs, said, told, woke };
}

describe('createFreshPullGate: what sync tells it (ADR-0035 part 4)', () => {
  it('acts on nothing before a pull completes, nor while one is under way', async () => {
    const { gate } = gateOn();
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'no-pull' });
    gate.started(VAULT);
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'pulling' });
  });

  it('opens once a sync completes, and records when it did and the counter as it began', async () => {
    const { gate, runs, told } = gateOn();
    await runs({ kind: 'synced' });
    expect(gate.standing(VAULT)).toEqual({
      kind: 'pulled',
      startedAsleepMs: 457_335_000,
      finishedAt: 1_000,
      namedAfter: true,
    });
    expect(told.at(-1)).toEqual(gate.standing(VAULT));
    expect(await gate.acts(VAULT)).toBe(true);
  });

  it('takes a look that finds nothing new as a completed pull', async () => {
    const { gate, runs } = gateOn();
    await runs({ kind: 'looked', behind: 0 });
    expect(await gate.acts(VAULT)).toBe(true);
  });

  it('voids what it knew once a look finds other Macs’ changes, until a sync brings them in', async () => {
    const { gate, runs } = gateOn();
    await runs({ kind: 'synced' });
    await runs({ kind: 'looked', behind: 2 });
    expect(gate.standing(VAULT)).toBeNull();
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'no-pull' });
    await runs({ kind: 'synced' });
    expect(await gate.acts(VAULT)).toBe(true);
  });

  it('voids what it knew once a sync fails: it may have brought files in first', async () => {
    const { gate, runs } = gateOn();
    await runs({ kind: 'synced' });
    await runs({ kind: 'sync-failed' });
    expect(await gate.acts(VAULT)).toBe(false);
  });

  it('keeps what it knew when a look fails: it changed no file', async () => {
    const { gate, runs } = gateOn();
    await runs({ kind: 'synced' });
    await runs({ kind: 'look-failed' });
    expect(await gate.acts(VAULT)).toBe(true);
  });

  it('acts on nothing after a sleep, until a pull started after the wake completes', async () => {
    const { gate, runs, sleep } = gateOn();
    await runs({ kind: 'synced' });
    sleep.sleep(8 * 60 * 60_000);
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'slept' });
    await runs({ kind: 'looked', behind: 0 });
    expect(await gate.acts(VAULT)).toBe(true);
  });

  it('counts for nothing a pull whose start could not be placed against a sleep', async () => {
    const { gate, sleep } = gateOn();
    sleep.unreadable();
    const startedAsleepMs = await gate.readAsleep();
    expect(startedAsleepMs).toBeNull();
    await gate.ended(VAULT, { kind: 'synced' }, startedAsleepMs);
    sleep.unreadable(false);
    expect(gate.standing(VAULT)).toBeNull();
  });

  it('re-judges against a pull that started while the facts were being read', async () => {
    const { gate, runs, sleep } = gateOn();
    await runs({ kind: 'synced' });
    const port = sleep.port.asleepMs;
    sleep.port.asleepMs = async () => {
      gate.started(VAULT);
      return port();
    };
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'pulling' });
  });
});

describe('createFreshPullGate: the settings (ADR-0035 part 4, "Unknown")', () => {
  it('runs nothing when the settings a pull brought name another Mac', async () => {
    const { gate, vault, runs } = gateOn();
    vault.settings = '---\nsync: github\nautomationsMac: mac-laptop\n---\n';
    await runs({ kind: 'synced' });
    expect(gate.standing(VAULT)).toMatchObject({ namedAfter: false });
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'not-named' });
  });

  it('runs nothing when the settings now name another Mac, though the pull’s named this one', async () => {
    const { gate, vault, runs } = gateOn();
    await runs({ kind: 'synced' });
    vault.settings = '---\nsync: github\nautomationsMac: mac-laptop\n---\n';
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'not-named' });
  });

  it('runs nothing, and says why once, when the settings a pull left cannot be read', async () => {
    const { gate, vault, runs, said } = gateOn();
    vault.settings = '---\nautomationsMac: [mac-studio\n---\n';
    await runs({ kind: 'synced' });
    expect(gate.standing(VAULT)).toEqual({ kind: 'settings-unreadable' });
    for (let look = 0; look < 3; look += 1) {
      expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'settings-unreadable' });
      await runs({ kind: 'looked', behind: 0 });
    }
    expect(said().filter((line) => line.includes('settings'))).toHaveLength(1);
  });

  it('takes a settings note missing after a pull as unreadable, not as naming no Mac', async () => {
    const { gate, vault, runs } = gateOn();
    vault.settings = null;
    await runs({ kind: 'synced' });
    expect(gate.standing(VAULT)).toEqual({ kind: 'settings-unreadable' });
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'settings-unreadable' });
  });

  it('takes a settings note gone since the pull as unreadable', async () => {
    const { gate, vault, runs } = gateOn();
    await runs({ kind: 'synced' });
    vault.settings = null;
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'settings-unreadable' });
  });

  it('says it again once the gates have opened and shut again for it', async () => {
    const { gate, vault, runs, said } = gateOn();
    vault.settings = '---\nautomationsMac: [\n---\n';
    await runs({ kind: 'synced' });
    await gate.verdict(VAULT);
    vault.settings = NAMED;
    await runs({ kind: 'synced' });
    expect(await gate.acts(VAULT)).toBe(true);
    vault.settings = '---\nautomationsMac: [\n---\n';
    await runs({ kind: 'synced' });
    await gate.verdict(VAULT);
    expect(said().filter((line) => line.includes('settings'))).toHaveLength(2);
  });
});

describe('createFreshPullGate: paused sync (ADR-0035 part 4)', () => {
  it('runs nothing while sync is paused on this Mac, and says so once', async () => {
    const { gate, vault, runs, said } = gateOn();
    await runs({ kind: 'synced' });
    vault.paused = true;
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'paused' });
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'paused' });
    expect(said()).toEqual([expect.stringMatching(/paused on this Mac, so automations wait/)]);
  });

  it('says paused, not waiting for a pull, on a Mac that opened the vault paused', async () => {
    const { gate } = gateOn({ paused: true });
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'paused' });
  });

  it('is not taken as paused before the vault is known to sync', async () => {
    const { gate } = gateOn({ paused: true });
    gate.opened('/Users/j/Work');
    expect(await gate.verdict('/Users/j/Work')).toEqual({ open: false, shut: 'no-pull' });
  });
});

describe('createFreshPullGate: a vault that does not sync', () => {
  it('acts as before, never reading the counter for it', async () => {
    const { gate, sleep } = gateOn({ paused: true });
    gate.inspected(VAULT, false);
    sleep.unreadable();
    expect(await gate.acts(VAULT, { modifiedAt: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(sleep.reads()).toBe(0);
  });

  it('is what a vault becomes whose inspection found no git on this Mac', async () => {
    const { gate } = gateOn();
    const missing = await withPrograms(() => Promise.reject(new ProgramMissingError('git'))).catch(
      (cause: unknown) => cause,
    );
    gate.inspectionFailed(VAULT, missing);
    expect(gate.standing(VAULT)).toEqual({ kind: 'not-synced' });
    expect(await gate.acts(VAULT)).toBe(true);
  });

  it('is not what an inspection that failed for another reason leaves', async () => {
    const { gate } = gateOn();
    gate.inspectionFailed(VAULT, new Error('fatal: not a git repository'));
    expect(gate.standing(VAULT)).toBeNull();
  });

  it('waits, once set up to sync, for its first pull', async () => {
    const { gate } = gateOn();
    gate.inspected(VAULT, false);
    gate.inspected(VAULT, true);
    expect(gate.standing(VAULT)).toBeNull();
    expect(await gate.acts(VAULT)).toBe(false);
  });
});

describe('createFreshPullGate: gate 1 (a pull completed after the file arrived)', () => {
  it('acts on a file modified before the pull completed, and not on one modified as or after it', async () => {
    const { gate, vault, runs } = gateOn();
    vault.now = 5_000;
    await runs({ kind: 'synced' });
    expect(await gate.acts(VAULT, { modifiedAt: 4_999 })).toBe(true);
    expect(await gate.verdict(VAULT, { modifiedAt: 5_000 })).toEqual({
      open: false,
      shut: 'arrived-after-pull',
    });
  });

  it('reads the notes’ modified times, and judges by the latest of them', async () => {
    const { gate, vault, runs } = gateOn();
    vault.now = 5_000;
    vault.modified.set('Inbox/Meetings/a.md', 1_000).set('Inbox/Meetings/b.md', 6_000);
    await runs({ kind: 'synced' });
    expect(await gate.acts(VAULT, { paths: ['Inbox/Meetings/a.md'] })).toBe(true);
    expect(await gate.acts(VAULT, { paths: ['Inbox/Meetings/a.md', 'Inbox/Meetings/b.md'] })).toBe(
      false,
    );
  });

  it('stays shut on a note whose vault cannot tell when it was written (ADR-0053)', async () => {
    const { gate, vault, runs } = gateOn();
    vault.now = 5_000;
    // A version, as the GitHub vault gives: read as a time it would look long before the pull.
    vault.modified.set('Inbox/Meetings/a.md', 1_000).set('Inbox/Meetings/b.md', 1_000);
    vault.timeUnknown.add('Inbox/Meetings/b.md');
    await runs({ kind: 'synced' });
    expect(await gate.acts(VAULT, { paths: ['Inbox/Meetings/a.md'] })).toBe(true);
    expect(
      await gate.verdict(VAULT, { paths: ['Inbox/Meetings/a.md', 'Inbox/Meetings/b.md'] }),
    ).toEqual({
      open: false,
      shut: 'arrived-after-pull',
    });
  });
});

describe('createFreshPullGate: one vault at a time', () => {
  it('forgets the last vault’s pull when another opens, and ignores news of it', async () => {
    const { gate, runs } = gateOn();
    await runs({ kind: 'synced' });
    gate.opened('/Users/j/Work');
    expect(gate.standing(VAULT)).toBeNull();
    expect(await gate.acts(VAULT)).toBe(false);
    gate.started(VAULT);
    expect(gate.standing('/Users/j/Work')).toBeNull();
  });
});

describe('createFreshPullGate: counting what waits on a Mac that is not named (ADR-0035 part 3)', () => {
  const OTHER = '---\nsync: github\nautomationsMac: mac-laptop\nautomationsMacName: Laptop\n---\n';

  it('opens against the pull on a Mac that is not named, which the import’s gate never does', async () => {
    const { gate, runs } = gateOn({ settings: OTHER });
    await runs({ kind: 'synced' });
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'not-named' });
    expect(await gate.countGate(VAULT)).toEqual({ open: true, standing: gate.standing(VAULT) });
  });

  it('during a pull says so, so a count is kept rather than flipped', async () => {
    const { gate, runs } = gateOn({ settings: OTHER });
    await runs({ kind: 'synced' });
    gate.started(VAULT);
    expect(await gate.countGate(VAULT)).toEqual({ open: false, why: 'pulling' });
  });

  it('tells, once, that the Mac slept since the last pull, as soon as any reading of the counter shows it (#627 review)', async () => {
    const { gate, runs, sleep, woke } = gateOn({ settings: OTHER });
    await runs({ kind: 'synced' });
    expect(gate.sleptSincePull(VAULT)).toBe(false);

    sleep.sleep(8 * 60 * 60_000);
    // A look starts after the wake and fails: the standing stays the last pull's.
    const startedAsleepMs = await gate.readAsleep();
    await gate.ended(VAULT, { kind: 'look-failed' }, startedAsleepMs);
    await gate.readAsleep();

    expect(gate.sleptSincePull(VAULT)).toBe(true);
    expect(woke).toEqual([VAULT]);
    // A pull started since the wake completes: it holds again.
    await runs({ kind: 'looked', behind: 0 });
    expect(gate.sleptSincePull(VAULT)).toBe(false);
  });

  it('gives no count before a pull completes, after a sleep, or while sync is paused', async () => {
    const { gate, runs, sleep, vault } = gateOn({ settings: OTHER });
    expect(await gate.countGate(VAULT)).toEqual({ open: false, why: 'no-pull' });
    await runs({ kind: 'synced' });
    sleep.sleep(60 * 60_000);
    expect(await gate.countGate(VAULT)).toEqual({ open: false, why: 'no-pull' });
    await runs({ kind: 'synced' });
    vault.paused = true;
    expect(await gate.countGate(VAULT)).toEqual({ open: false, why: 'paused' });
  });

  it('gives none for a vault that does not sync, never reading the counter for it', async () => {
    const { gate, sleep } = gateOn({ settings: OTHER });
    gate.inspected(VAULT, false);
    expect(await gate.countGate(VAULT)).toEqual({ open: false, why: 'not-synced' });
    expect(sleep.reads()).toBe(0);
  });

  it('is judged against a pull that started while the counter was read', async () => {
    const { gate, runs, sleep } = gateOn({ settings: OTHER });
    await runs({ kind: 'synced' });
    const port = sleep.port.asleepMs;
    sleep.port.asleepMs = async () => {
      gate.started(VAULT);
      return port();
    };
    expect(await gate.countGate(VAULT)).toEqual({ open: false, why: 'pulling' });
  });
});

describe('createFreshPullGate: whether "Process here" may claim (ADR-0035 part 2, #176)', () => {
  const OTHER = '---\nsync: github\nautomationsMac: mac-laptop\nautomationsMacName: Laptop\n---\n';
  const READY = { kind: 'ready' } as const;
  const FAILED = { kind: 'failed', reason: 'offline', at: 1 } as const;

  it('lets a Mac that is not named claim once a pull since launch has completed', async () => {
    const { gate, runs } = gateOn({ settings: OTHER });
    expect(await gate.claimRefusal(VAULT, READY)).toBe('no-pull');
    await runs({ kind: 'synced' });
    expect(await gate.claimRefusal(VAULT, READY)).toBeNull();
  });

  it('refuses after a sleep, while paused, while failing, and during a pull', async () => {
    const { gate, runs, sleep, vault } = gateOn({ settings: OTHER });
    await runs({ kind: 'synced' });
    expect(await gate.claimRefusal(VAULT, FAILED)).toBe('failing');
    gate.started(VAULT);
    expect(await gate.claimRefusal(VAULT, READY)).toBe('pulling');
    await runs({ kind: 'synced' });
    sleep.sleep(60 * 60_000);
    expect(await gate.claimRefusal(VAULT, READY)).toBe('no-pull');
    await runs({ kind: 'synced' });
    vault.paused = true;
    expect(await gate.claimRefusal(VAULT, READY)).toBe('paused');
  });

  it('is judged against a pull that started while the counter was read', async () => {
    const { gate, runs, sleep } = gateOn({ settings: OTHER });
    await runs({ kind: 'synced' });
    const port = sleep.port.asleepMs;
    sleep.port.asleepMs = async () => {
      gate.started(VAULT);
      return port();
    };
    expect(await gate.claimRefusal(VAULT, READY)).toBe('pulling');
  });

  it('refuses for a vault that does not sync, never reading the counter for it', async () => {
    const { gate, sleep } = gateOn({ settings: OTHER });
    gate.inspected(VAULT, false);
    expect(await gate.claimRefusal(VAULT, READY)).toBe('not-synced');
    expect(sleep.reads()).toBe(0);
  });
});

describe('createFreshPullGate: a claim not yet pushed keeps the gates shut (#630 review)', () => {
  it('stays shut after a look that brings nothing, though the settings name this Mac', async () => {
    const { gate, runs } = gateOn();
    await runs({ kind: 'synced' });
    gate.claimed(VAULT);

    await runs({ kind: 'looked', behind: 0 });

    expect(gate.claimUnshared(VAULT)).toBe(true);
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'claim-unshared' });
  });

  it('stays shut after a sync that failed, and opens once one succeeds, which pushed the claim', async () => {
    const { gate, runs } = gateOn();
    await runs({ kind: 'synced' });
    gate.claimed(VAULT);
    await runs({ kind: 'sync-failed' });
    expect(gate.claimUnshared(VAULT)).toBe(true);

    await runs({ kind: 'synced' });

    expect(gate.claimUnshared(VAULT)).toBe(false);
    expect(await gate.verdict(VAULT)).toEqual({ open: true });
  });

  it('keeps a claim by vault: opened again, it still waits; none is marked in a vault that does not sync (#630 attack)', async () => {
    const { gate } = gateOn();
    gate.claimed(VAULT, 'Laptop');
    gate.opened('/Users/j/Other');
    gate.opened(VAULT);
    expect(gate.claimUnshared(VAULT)).toBe(true);
    expect(gate.claimWas(VAULT)).toBe('Laptop');

    gate.opened('/Users/j/Plain');
    gate.inspected('/Users/j/Plain', false);
    gate.claimed('/Users/j/Plain');
    expect(gate.claimUnshared('/Users/j/Plain')).toBe(false);
  });

  it('tells whatever draws the banner as the claim is marked and as it is shared', async () => {
    const { gate, runs, told } = gateOn();
    await runs({ kind: 'synced' });
    const before = told.length;
    gate.claimed(VAULT);
    expect(told.length).toBe(before + 1);
    await runs({ kind: 'synced' });
    expect(told.length).toBeGreaterThan(before + 1);
  });
});

describe('createFreshPullGate: a claim judged from git, which a restart does not forget (#630 attack)', () => {
  /** A gate as a fresh launch makes it, over GitHub's settings as the last fetch left them. */
  function launched(
    onGitHub: () => Promise<{ automationsMac: string | null; automationsMacName: string | null }>,
    { paused = false } = {},
  ) {
    const sleep = fakeSleepClock();
    const asked: string[] = [];
    const activity = recordingActivity();
    const gate = createFreshPullGate({
      ports: {
        sleepClock: sleep.port,
        fs: fakeVaultFs({
          readNotes: async () => [
            { path: '.atlas/settings.md', text: NAMED, modified: 1, size: 1 },
          ],
        }),
        markdown: { ...fakeMarkdown(), frontmatterProblem: () => null },
        clock: { now: () => 1_000 },
        activity,
        onGitHub,
      },
      here: { thisMacId: () => THIS_MAC, paused: () => paused },
      onClaimUnshared: (vault) => void asked.push(vault),
    });
    gate.opened(VAULT);
    gate.inspected(VAULT, true);
    const runs = async (end: Parameters<typeof gate.ended>[1]) => {
      const startedAsleepMs = await gate.readAsleep();
      if (end.kind === 'synced') gate.started(VAULT);
      await gate.ended(VAULT, end, startedAsleepMs);
    };
    return { gate, runs, asked, activity };
  }
  const STUDIO_ON_GITHUB = { automationsMac: 'mac-laptop', automationsMacName: 'Laptop' };

  it('shuts after a look when the settings here name this Mac and GitHub’s do not, and asks for a sync to push it', async () => {
    const { gate, runs, asked } = launched(async () => STUDIO_ON_GITHUB);
    await runs({ kind: 'looked', behind: 0 });
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'claim-unshared' });
    expect(gate.claimWas(VAULT)).toBe('Laptop');
    expect(asked).toEqual([VAULT]);
  });

  it('asks for no sync while sync is paused here: resuming is what pushes it', async () => {
    const { runs, asked } = launched(async () => STUDIO_ON_GITHUB, { paused: true });
    await runs({ kind: 'looked', behind: 0 });
    expect(asked).toEqual([]);
  });

  it('asks for no sync after a sync, which already pushed what it could', async () => {
    const { runs, asked } = launched(async () => STUDIO_ON_GITHUB);
    await runs({ kind: 'synced' });
    expect(asked).toEqual([]);
  });

  it('says once in Activity that GitHub’s settings could not be read, and waits (#630 review)', async () => {
    const { gate, runs, activity } = launched(async () => {
      throw new Error('fatal: bad object');
    });
    await runs({ kind: 'looked', behind: 0 });
    await runs({ kind: 'looked', behind: 0 });
    expect(await gate.verdict(VAULT)).toEqual({ open: false, shut: 'claim-unshared' });
    expect(activity.reports).toEqual([
      {
        level: 'warning',
        kind: 'sync',
        message:
          'Automations wait: DFAI could not read this vault’s settings on GitHub to confirm the claim.',
        subject: null,
      },
    ]);
  });

  it('opens once GitHub names this Mac', async () => {
    const { gate, runs } = launched(async () => ({
      automationsMac: THIS_MAC,
      automationsMacName: 'Studio',
    }));
    await runs({ kind: 'looked', behind: 0 });
    expect(await gate.verdict(VAULT)).toEqual({ open: true });
  });
});
