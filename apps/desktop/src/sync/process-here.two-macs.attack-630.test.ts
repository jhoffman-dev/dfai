/**
 * Attack on PR #630 (#176): "Process here" against two Macs sharing one real
 * remote. Each Mac is the real `syncNow`, `checkRemote`, `claimAutomations`
 * and settings writer over real git (the two-Macs harness), with the real
 * gates (`createFreshPullGate`) and the schedule's own rules (`syncAfterLook`,
 * sync on open unless paused, a sync after an edit). The app around them is
 * modelled as `useSyncRuns` / `useSyncSchedule` / `useInspection` wire them.
 *
 * The safety property (ADR-0035 part 4): a Mac's gates are open only while the
 * settings on GitHub, as its last completed pull found them, named it. That
 * is what "the other Mac's last word is known" means; the documented window
 * (two Macs open until the loser's next pull) satisfies it, because each
 * Mac's last pull saw itself named on GitHub.
 */
import { describe, expect, it } from 'vitest';
import {
  automationsMacOf,
  githubSettingsUnreadableReport,
  syncAfterLook,
  type PullEnd,
  type SyncPhase,
} from '@dfai/domain';
import {
  automationsOnGitHub,
  checkRemote,
  claimAutomations,
  createFreshPullGate,
  type FreshPullGate,
  type GitPort,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';
import { sh, TIMEOUT, twoMacs, vaultFsOf, type Mac } from './two-macs.harness.ts';

const VAULT = '/vault';
const SETTINGS = '.atlas/settings.md';
const STUDIO_NAMED =
  '---\nsync: github\nautomationsMac: mac-studio\nautomationsMacName: Studio\n---\n';
const IDS: Record<string, string> = { Studio: 'mac-studio', Laptop: 'mac-laptop' };

const failed = { code: 1, stdout: '', stderr: 'Could not resolve host: github.com' };
const offlineGit: Partial<GitPort> = { fetch: async () => failed, push: async () => failed };

/** Who the settings on "GitHub" (the bare remote) name, by id; null when none. */
async function namedOnGitHub(bare: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const shown = await sh(bare, ['show', `main:${SETTINGS}`], env);
  if (shown.code !== 0) return null;
  const line = /^automationsMac: (.*)$/m.exec(shown.stdout);
  return automationsMacOf(line?.[1] ?? null);
}

/**
 * One Mac running DFAI: its gates and its session. A restart makes a new
 * session: the gates, the schedule's memory of edits and the claim's
 * "not yet shared" are gone; the pause, kept per Mac, is not.
 */
function macApp(
  mac: Mac,
  world: { bare: string; env: NodeJS.ProcessEnv },
  /** Whether a look that finds this Mac's claim not on GitHub syncs to push it, as `useSync` does. */
  { pushesUnshared = false } = {},
) {
  const id = IDS[mac.name] ?? mac.name;
  /** How GitHub's settings read fails now (#630 round 2): not at all, as git's error, or as the host's refusal. */
  let readFault: 'none' | 'git' | 'host' = 'none';
  /** Whether the last read of GitHub's settings this session failed; undefined before one. */
  let lastReadFailed: boolean | undefined;
  /** The unreadable reports said, and the ones the spec asks for: once a failing streak a session. */
  const unreadable = { said: 0, expected: 0, streakSaid: false };
  const readingGit: GitPort = {
    ...mac.git,
    remoteSettings: async (branch) => {
      if (readFault === 'host') {
        lastReadFailed = true;
        throw new Error(
          `origin/${branch} is not the branch checked out, so its settings are not read`,
        );
      }
      const read =
        readFault === 'git'
          ? { code: 128, stdout: '', stderr: 'fatal: bad object origin/main' }
          : await mac.git.remoteSettings(branch);
      const missing = /does not exist in '/.test(read.stderr);
      lastReadFailed = read.code !== 0 && !missing;
      return read;
    },
  };
  const noteRead = (failedRead: boolean) => {
    if (!failedRead) unreadable.streakSaid = false;
    else if (!unreadable.streakSaid) {
      unreadable.streakSaid = true;
      unreadable.expected += 1;
    }
  };
  const fs = vaultFsOf(mac);
  let now = 1_000;
  const tick = () => (now += 1_000);
  let paused = false;
  let online = true;
  let pushWanted = false;
  /** The claim's "not yet shared" as the window draws it, each time it changes. */
  const standings: { unshared: boolean }[] = [];
  const session = {
    gate: null as FreshPullGate | null,
    lastSyncAt: null as number | null,
    lastEditAt: null as number | null,
    /** What GitHub named as this Mac's last completed pull found it; undefined before one. */
    namedAtLastPull: undefined as string | null | undefined,
    /** How the last sync or look ended, as `useSyncRuns` sets the phase. */
    phase: { kind: 'unknown' } as SyncPhase,
  };
  const newGate = () =>
    createFreshPullGate({
      ports: {
        sleepClock: { asleepMs: async () => 0 },
        fs,
        markdown: remarkMarkdown,
        clock: { now: () => now },
        activity: {
          inVault: () => ({
            record: (report) => {
              if (report.message === githubSettingsUnreadableReport().message) unreadable.said += 1;
            },
          }),
        },
        // What the app wires (#630 attack fix): GitHub's settings as the fetch left them.
        onGitHub: async () => {
          try {
            const read = await automationsOnGitHub({ git: readingGit, markdown: remarkMarkdown });
            noteRead(false);
            return read;
          } catch (error) {
            noteRead(true);
            throw error;
          }
        },
      },
      here: { thisMacId: () => id, paused: () => paused },
      onClaimUnshared: () => void (pushWanted = pushesUnshared),
      onStanding: (vault) => {
        const unsharedNow = session.gate?.claimUnshared(vault) ?? false;
        if (unsharedNow !== standings.at(-1)?.unshared) standings.push({ unshared: unsharedNow });
      },
    });
  const gate = () => {
    if (session.gate === null) throw new Error(`${mac.name} is not running`);
    return session.gate;
  };
  const ended = async (end: PullEnd) => {
    await gate().ended(VAULT, end, 0);
    const failedNow = end.kind === 'sync-failed' || end.kind === 'look-failed';
    session.phase = failedNow ? { kind: 'failed', reason: 'offline', at: now } : { kind: 'ready' };
    const completes = end.kind === 'synced' || (end.kind === 'looked' && end.behind === 0);
    if (completes) session.namedAtLastPull = await namedOnGitHub(world.bare, world.env);
  };

  const sync = async (): Promise<boolean> => {
    tick();
    session.lastSyncAt = now;
    gate().started(VAULT);
    try {
      await mac.sync(online ? {} : { git: offlineGit });
    } catch {
      await ended({ kind: 'sync-failed' });
      return false;
    }
    await ended({ kind: 'synced' });
    return true;
  };

  /** `useSyncSchedule`'s look, and the sync `syncAfterLook` asks for. */
  const look = async () => {
    if (paused) return;
    tick();
    let found: { behind: number; ahead: number };
    try {
      found = await checkRemote({ git: online ? mac.git : { ...mac.git, ...offlineGit } });
    } catch {
      await ended({ kind: 'look-failed' });
      return;
    }
    await ended({ kind: 'looked', behind: found.behind });
    const since = { lastSyncAt: session.lastSyncAt, lastEditAt: session.lastEditAt };
    const pushNow = pushWanted;
    pushWanted = false;
    if (pushNow || syncAfterLook({ ...found, ...since })) await sync();
  };

  /** `useSyncSchedule`'s push timer: a sync once an edit this session has settled. */
  const pushTimer = async () => {
    if (paused || session.lastEditAt === null) return;
    if (session.lastSyncAt !== null && session.lastEditAt < session.lastSyncAt) return;
    await sync();
  };

  /** Launch: the gates know nothing; `useInspection` pulls on open unless paused. */
  const launch = async () => {
    session.gate = newGate();
    lastReadFailed = undefined;
    unreadable.streakSaid = false;
    session.lastSyncAt = null;
    session.lastEditAt = null;
    session.namedAtLastPull = undefined;
    session.phase = { kind: 'unknown' };
    gate().opened(VAULT);
    gate().inspected(VAULT, true);
    if (!paused) await sync();
  };

  /** Quit (the close sync runs unless paused, within its wait), then launch again. */
  const restart = async () => {
    if (!paused) await sync();
    session.gate = null;
    await launch();
  };

  /** Settings → Sync's claim (gated: false) or "Process here" (gated: true), as `useClaimAutomations` does. */
  const claim = async (gated: boolean) => {
    const outcome = await claimAutomations({
      ports: {
        settings: vaultSettingsWriter({ fs, markdown: remarkMarkdown }),
        fs,
        markdown: remarkMarkdown,
      },
      mac: { id, name: mac.name },
      syncs: true,
      stillOpen: () => true,
      ...(gated && {
        refusal: () => gate().claimRefusal(VAULT, session.phase),
      }),
    });
    if (outcome.kind !== 'claimed') return outcome;
    tick();
    // Generous to the PR: the settings write is an edit the schedule sees.
    session.lastEditAt = now;
    gate().claimed(VAULT);
    if (!paused) await sync();
    return outcome;
  };

  /** A timing edit to the settings note on this Mac (another key in the same file). */
  const editSettings = async (pushDelaySeconds: number) => {
    await vaultSettingsWriter({ fs, markdown: remarkMarkdown }).save({ pushDelaySeconds });
    tick();
    session.lastEditAt = now;
  };

  const editNote = async (text: string) => {
    await mac.write('Inbox/scratch.md', text);
    tick();
    session.lastEditAt = now;
  };

  /** Whether this Mac's gates let a Claude step run now. */
  const open = async () => session.gate !== null && (await session.gate.verdict(VAULT)).open;

  /** The property: open only while its last completed pull saw GitHub name it. */
  const openWithoutWord = async () => (await open()) && session.namedAtLastPull !== id;

  return {
    name: mac.name,
    id,
    launch,
    restart,
    sync,
    look,
    pushTimer,
    claim,
    editSettings,
    editNote,
    open,
    openWithoutWord,
    setPaused: (next: boolean) => void (paused = next),
    standings: () => standings.map((each) => each.unshared),
    setReadFault: (next: 'none' | 'git' | 'host') => void (readFault = next),
    /** Open although the last read of GitHub's settings failed: the gates must be shut then. */
    openOnFailedRead: async () => lastReadFailed === true && (await open()),
    unreadable: () => ({ said: unreadable.said, expected: unreadable.expected }),
    setOnline: (next: boolean) => void (online = next),
    claimUnshared: () => session.gate !== null && session.gate.claimUnshared(VAULT),
    localNamed: async () =>
      automationsMacOf(/^automationsMac: (.*)$/m.exec(await mac.read(SETTINGS))?.[1] ?? null),
  };
}

async function world(options: { pushesUnshared?: boolean } = {}) {
  const made = await twoMacs({ [SETTINGS]: STUDIO_NAMED, 'Inbox/a.md': 'a\n' });
  const studio = macApp(made.studio, made, options);
  const laptop = macApp(made.laptop, made, options);
  await studio.launch();
  await laptop.launch();
  return { ...made, studio, laptop, studioRoot: made.studio.root, laptopMac: made.laptop };
}

describe('Process here across a restart before the claim is pushed (PR #630 attack)', () => {
  it(
    'a claim written while paused, then a restart and a resume: the gates stay shut until the claim reaches GitHub',
    async () => {
      const { laptop, studio, bare, env } = await world();
      laptop.setPaused(true);
      // Settings → Sync while paused: written here, left for the next sync (the #630 review fix).
      expect((await laptop.claim(false)).kind).toBe('claimed');
      expect(laptop.claimUnshared()).toBe(true);

      // The app quits (no close sync while paused) and opens again; the person resumes sync.
      await laptop.restart();
      laptop.setPaused(false);
      // The schedule's first tick is a look: nothing to bring in, nothing ahead (the claim is not committed).
      await laptop.look();
      await laptop.pushTimer();
      await studio.look();

      expect(await namedOnGitHub(bare, env)).toBe('mac-studio');
      expect(await laptop.localNamed()).toBe('mac-laptop');
      // Studio still runs, rightly: GitHub names it.
      expect(await studio.open()).toBe(true);
      // The laptop must not: GitHub has never heard of its claim.
      expect(await laptop.open()).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'the restart gap is not bounded by a pull interval: looks keep reopening the laptop while Studio also runs',
    async () => {
      const { laptop, studio, bare, env } = await world();
      laptop.setPaused(true);
      await laptop.claim(false);
      await laptop.restart();
      laptop.setPaused(false);

      // An hour of the schedule: a look a minute on both Macs, no one types on the laptop.
      let bothOpen = 0;
      for (let minute = 0; minute < 6; minute += 1) {
        await laptop.look();
        await laptop.pushTimer();
        await studio.look();
        if ((await laptop.open()) && (await studio.open())) bothOpen += 1;
      }

      expect(await namedOnGitHub(bare, env)).toBe('mac-studio');
      expect(bothOpen).toBe(0);
    },
    TIMEOUT,
  );
});

describe('a claim not yet pushed is pushed by the next look (PR #630 attack fix)', () => {
  it(
    'after a restart while paused and a resume, the first look pushes the claim; the laptop opens only once GitHub names it, and Studio stands down',
    async () => {
      const { laptop, studio, bare, env } = await world({ pushesUnshared: true });
      laptop.setPaused(true);
      await laptop.claim(false);
      await laptop.restart();
      expect(laptop.claimUnshared()).toBe(false);
      laptop.setPaused(false);

      await laptop.look();

      expect(await namedOnGitHub(bare, env)).toBe('mac-laptop');
      expect(await laptop.open()).toBe(true);
      expect(await laptop.openWithoutWord()).toBe(false);
      await studio.look();
      expect(await studio.open()).toBe(false);
    },
    TIMEOUT,
  );
});

describe('a claim not yet pushed, within one session (PR #630 attack)', () => {
  it(
    'offline, then an edit, then a look that brings nothing: the gates stay shut until a sync pushes the claim',
    async () => {
      const { laptop, bare, env } = await world();
      await laptop.look();
      laptop.setOnline(false);
      expect((await laptop.claim(false)).kind).toBe('claimed');
      // Typing goes on: the look below then leaves the push to the push timer.
      await laptop.editNote('typing\n');
      laptop.setOnline(true);
      await laptop.look();

      expect(await namedOnGitHub(bare, env)).toBe('mac-studio');
      expect(await laptop.open()).toBe(false);

      await laptop.pushTimer();
      expect(await namedOnGitHub(bare, env)).toBe('mac-laptop');
      expect(await laptop.open()).toBe(true);
    },
    TIMEOUT,
  );
});

describe('the documented window (PR #630 attack)', () => {
  it(
    'a pushed claim leaves the Mac named before running only until its next look',
    async () => {
      const { laptop, studio, bare, env } = await world();
      await laptop.look();
      expect((await laptop.claim(true)).kind).toBe('claimed');
      expect(await namedOnGitHub(bare, env)).toBe('mac-laptop');
      // Documented window: Studio still open until it pulls.
      expect(await studio.open()).toBe(true);
      expect(await laptop.open()).toBe(true);
      await studio.look();
      expect(await studio.open()).toBe(false);
      // A look that voids the standing is followed by the sync that brings the claim in.
      expect(await studio.localNamed()).toBe('mac-laptop');
      expect(await laptop.open()).toBe(true);
    },
    TIMEOUT,
  );
});

/** mulberry32: a small seeded generator, so each run of a seed is the same run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SEEDS = Array.from(
  { length: Number(process.env['CLAIM_PROPERTY_SEEDS'] ?? 8) },
  (_, at) => at + 1,
);
const STEPS = 50;
/** Each action with its weight: the moves that change who is named, and the looks that judge it, come often. */
const ACTIONS = [
  ['claim-gated', 2],
  ['claim-settings', 3],
  ['sync', 2],
  ['look', 5],
  ['push-timer', 2],
  // A claim left unpushed — paused, offline, then a restart — is what the gates must hold shut on.
  ['pause', 4],
  ['resume', 3],
  ['offline', 3],
  ['online', 2],
  ['restart', 3],
  // Quit while paused and come back, then resume: nothing is sent on the way out or in, and the
  // schedule's first tick after the resume is a look.
  ['restart-paused', 3],
  ['edit-settings', 1],
  ['edit-note', 2],
] as const;
const TOTAL_WEIGHT = ACTIONS.reduce((sum, [, weight]) => sum + weight, 0);

function pick(random: () => number): (typeof ACTIONS)[number][0] {
  let roll = random() * TOTAL_WEIGHT;
  for (const [action, weight] of ACTIONS) {
    roll -= weight;
    if (roll < 0) return action;
  }
  return 'look';
}

describe('Process here as a seeded schedule over two real clones (PR #630 attack)', () => {
  it.each(SEEDS)(
    'seed %i: no Mac runs the automations without GitHub having named it at its last pull, and one Mac stays named',
    async (seed) => {
      // A third of the seeds push a claim a look finds unshared, as the app does; the rest leave it to
      // the schedule, which is where a claim stays unshared long enough for the gates to matter.
      const { studio, laptop, bare, env } = await world({ pushesUnshared: seed % 3 === 0 });
      const random = seeded(seed);
      const steps: string[] = [];
      const breaches: string[] = [];
      let mac = laptop;
      for (let step = 0; step < STEPS; step += 1) {
        // A Mac keeps the turn for a while, so a sequence on one Mac plays out.
        if (random() < 0.15) mac = mac === laptop ? studio : laptop;
        const action = pick(random);
        // A claim is made where it changes something: on a Mac whose own settings do not name it.
        if (action.startsWith('claim') && (await mac.localNamed()) === mac.id) {
          mac = mac === laptop ? studio : laptop;
        }
        steps.push(`${mac.name}:${action}`);
        if (action === 'claim-gated') steps.push(`=${(await mac.claim(true)).kind}`);
        if (action === 'claim-settings') steps.push(`=${(await mac.claim(false)).kind}`);
        if (action === 'sync') await mac.sync();
        if (action === 'look') await mac.look();
        if (action === 'push-timer') await mac.pushTimer();
        if (action === 'pause') mac.setPaused(true);
        if (action === 'resume') mac.setPaused(false);
        if (action === 'offline') mac.setOnline(false);
        if (action === 'online') mac.setOnline(true);
        if (action === 'restart') await mac.restart();
        if (action === 'restart-paused') {
          mac.setPaused(true);
          await mac.restart();
          mac.setPaused(false);
          await mac.look();
        }
        if (action === 'edit-settings') await mac.editSettings(30 + step);
        if (action === 'edit-note') await mac.editNote(`${mac.name} ${step}\n`);
        for (const each of [studio, laptop]) {
          if (await each.openWithoutWord()) breaches.push(`${each.name} after ${steps.join(' ')}`);
        }
        // Never neither: GitHub always names one of the two, never a blank.
        expect([IDS['Studio'], IDS['Laptop']], steps.join(' ')).toContain(
          await namedOnGitHub(bare, env),
        );
      }
      if (process.env['CLAIM_PROPERTY_TRACE'])
        process.stderr.write(`TRACE ${seed} ${steps.join(' ')}\n`);
      expect(breaches, `seed ${seed}`).toEqual([]);
    },
    TIMEOUT * 4,
  );
});

/** Round 2 (#630): restarts, pauses and an unreadable GitHub weigh more. */
const ACTIONS_UNREADABLE = [
  ['claim-gated', 2],
  ['claim-settings', 3],
  ['sync', 2],
  ['look', 5],
  ['push-timer', 1],
  ['pause', 4],
  ['resume', 3],
  ['offline', 2],
  ['online', 2],
  ['restart', 5],
  ['restart-paused', 5],
  ['read-fails-git', 3],
  ['read-fails-host', 2],
  ['read-ok', 4],
  ['edit-note', 1],
] as const;
const UNREADABLE_WEIGHT = ACTIONS_UNREADABLE.reduce((sum, [, weight]) => sum + weight, 0);

function pickUnreadable(random: () => number): (typeof ACTIONS_UNREADABLE)[number][0] {
  let roll = random() * UNREADABLE_WEIGHT;
  for (const [action, weight] of ACTIONS_UNREADABLE) {
    roll -= weight;
    if (roll < 0) return action;
  }
  return 'look';
}

describe('Process here with GitHub’s settings sometimes unreadable, seeded (PR #630 round 2 attack)', () => {
  it.each(SEEDS)(
    'seed %i: the gates are shut after a failed read, open only on GitHub’s word, and "unreadable" is said once a failing streak',
    async (seed) => {
      const { studio, laptop, bare, env } = await world({ pushesUnshared: seed % 2 === 0 });
      const random = seeded(seed * 7919);
      const steps: string[] = [];
      const breaches: string[] = [];
      let mac = laptop;
      for (let step = 0; step < STEPS; step += 1) {
        if (random() < 0.2) mac = mac === laptop ? studio : laptop;
        const action = pickUnreadable(random);
        if (action.startsWith('claim') && (await mac.localNamed()) === mac.id) {
          mac = mac === laptop ? studio : laptop;
        }
        steps.push(`${mac.name}:${action}`);
        if (action === 'claim-gated') steps.push(`=${(await mac.claim(true)).kind}`);
        if (action === 'claim-settings') steps.push(`=${(await mac.claim(false)).kind}`);
        if (action === 'sync') await mac.sync();
        if (action === 'look') await mac.look();
        if (action === 'push-timer') await mac.pushTimer();
        if (action === 'pause') mac.setPaused(true);
        if (action === 'resume') mac.setPaused(false);
        if (action === 'offline') mac.setOnline(false);
        if (action === 'online') mac.setOnline(true);
        if (action === 'restart') await mac.restart();
        if (action === 'restart-paused') {
          mac.setPaused(true);
          await mac.restart();
          mac.setPaused(false);
          await mac.look();
        }
        if (action === 'read-fails-git') mac.setReadFault('git');
        if (action === 'read-fails-host') mac.setReadFault('host');
        if (action === 'read-ok') mac.setReadFault('none');
        if (action === 'edit-note') await mac.editNote(`${mac.name} ${step}\n`);
        for (const each of [studio, laptop]) {
          if (await each.openWithoutWord())
            breaches.push(`open without word: ${each.name} after ${steps.join(' ')}`);
          if (await each.openOnFailedRead())
            breaches.push(`open on failed read: ${each.name} after ${steps.join(' ')}`);
          const told = each.unreadable();
          if (told.said !== told.expected)
            breaches.push(
              `unreadable said ${told.said}, expected ${told.expected}: ${each.name} after ${steps.join(' ')}`,
            );
        }
        expect([IDS['Studio'], IDS['Laptop']], steps.join(' ')).toContain(
          await namedOnGitHub(bare, env),
        );
      }
      expect(breaches.slice(0, 1), `seed ${seed}`).toEqual([]);
    },
    TIMEOUT * 4,
  );
});

describe('GitHub holding no settings note (PR #630 round 2 attack)', () => {
  it(
    'a note missing from origin/<branch> names no Mac, and the read does not throw',
    async () => {
      const { laptopMac, studioRoot, bare, env } = await world();
      await sh(studioRoot, ['rm', '--quiet', SETTINGS], env);
      await sh(studioRoot, ['commit', '--quiet', '-m', 'no settings'], env);
      await sh(studioRoot, ['push', '--quiet', 'origin', 'HEAD'], env);
      expect(await namedOnGitHub(bare, env)).toBeNull();
      await sh(laptopMac.root, ['fetch', '--quiet', 'origin'], env);
      await expect(
        automationsOnGitHub({ git: laptopMac.git, markdown: remarkMarkdown }),
      ).resolves.toEqual({ automationsMac: null, automationsMacName: null });
    },
    TIMEOUT,
  );

  it(
    'a branch never pushed to origin is a failed read, not "no Mac named"',
    async () => {
      const { laptopMac, env } = await world();
      await sh(laptopMac.root, ['checkout', '--quiet', '-b', 'unpushed'], env);
      await expect(
        automationsOnGitHub({ git: laptopMac.git, markdown: remarkMarkdown }),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );
});

describe('"now runs" after a restart is said only for a claim GitHub shows (PR #630 round 2 attack)', () => {
  it(
    'reachable: after a restart, the claim reads "not shared" and then "shared" because Studio took over, not because GitHub names the laptop',
    async () => {
      const { laptop, studio, bare, env } = await world();
      await laptop.look();
      expect((await laptop.claim(false)).kind).toBe('claimed');
      expect(await namedOnGitHub(bare, env)).toBe('mac-laptop');
      // A later session: the laptop's claim is history; Studio takes the automations back.
      await laptop.restart();
      await studio.look();
      expect((await studio.claim(true)).kind).toBe('claimed');
      expect(await namedOnGitHub(bare, env)).toBe('mac-studio');
      await laptop.look();
      // useSharedAfterRestart says "Laptop now runs the automations" on exactly this flip.
      expect(laptop.standings()).toEqual([false, true, false]);
      expect(await laptop.localNamed()).toBe('mac-studio');
      expect(await namedOnGitHub(bare, env)).toBe('mac-studio');
    },
    TIMEOUT,
  );
});
