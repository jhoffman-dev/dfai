// @vitest-environment jsdom
/**
 * Adversarial (#174, ADR-0035 part 4): the real gate (`usePulledFiles`) wired
 * to the real import hook (`useMeetingImport`), driven the way the sync hook
 * drives it — `pulls.ended` at the counter reading taken as the pull or
 * look started — with the host's sleep counter faked (`fakeSleepClock`).
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import {
  createActivityLog,
  createNoteChanges,
  fakeIndexPort,
  fakeSleepClock,
  fakeVaultFs,
  memoryActivityStore,
  recordingActivity,
  type ActivityLog,
  type MeetingImportPorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useMeetingImport } from '../meetings/use-meeting-import.ts';
import { usePulledFiles } from './use-pulled-files.ts';
import { githubHolding } from './github-settings.test-support.ts';

const VAULT = '/Users/j/Notes';
const THIS_MAC = 'mac-studio';
const SETTINGS = `---\nsync: github\nautomationsMac: ${THIS_MAC}\nautomationsMacName: Studio\n---\n`;
/** Breaks the import contract (no provider or id): the import writes an error stamp into it. */
const BROKEN_TEXT = '---\ntype: meeting\natlas_import: meeting/v1\n---\n\nNotes.\n';

const dir = (path: string): VaultEntry =>
  ({
    kind: 'directory',
    name: path.slice(path.lastIndexOf('/') + 1),
    path: createVaultPath(path),
  }) as VaultEntry;
const file = (path: string): VaultEntry =>
  ({
    kind: 'file',
    name: path.slice(path.lastIndexOf('/') + 1),
    path: createVaultPath(path),
  }) as VaultEntry;

/** A synced vault naming this Mac, with these files in `Inbox/Meetings`, each modified at the time given. */
function vaultWith(meetings: Record<string, { text: string; modified: number }>) {
  const written: string[] = [];
  const reads: string[] = [];
  let onRead: (path: string) => void = () => {};
  const fs = fakeVaultFs({
    listDirectory: async (at) =>
      at === ''
        ? [dir('Inbox')]
        : at === 'Inbox'
          ? [dir('Inbox/Meetings')]
          : Object.keys(meetings).map(file),
    readTextFile: async (path) => {
      reads.push(path);
      onRead(path);
      const meeting = meetings[path];
      if (meeting === undefined) throw new Error('no such note');
      return meeting;
    },
    readNotes: async (paths) =>
      paths
        .filter((path) => path === '.atlas/settings.md')
        .map((path) => ({ path, text: SETTINGS, modified: 1, size: 1 })),
    writeTextFile: async ({ path }) => {
      written.push(path);
      return 2;
    },
  });
  const ports: MeetingImportPorts = {
    fs,
    index: fakeIndexPort(),
    markdown: remarkMarkdown,
    editors: {
      state: () => 'closed',
      flush: async () => undefined,
      follow: () => undefined,
      abandon: () => undefined,
      reload: () => undefined,
    },
  };
  return { fs, ports, written, reads, whenRead: (then: (path: string) => void) => (onRead = then) };
}

/** The gate and the import, as `app.tsx` wires them, on a Mac the settings name. */
function wire({
  vault,
  sleep,
  now,
  activity = recordingActivity(),
}: {
  vault: ReturnType<typeof vaultWith>;
  sleep: ReturnType<typeof fakeSleepClock>;
  now: () => number;
  activity?: ActivityLog;
}) {
  const changes = createNoteChanges({ onError: () => undefined });
  // Held steady across renders, as the window's are.
  const pullClock = { now };
  const importClock = { today: () => '2026-10-14' };
  const onWritten = () => undefined;
  const hook = renderHook(
    ({ indexReady }: { indexReady: boolean }) => {
      const { gate, pulls } = usePulledFiles({
        vaultKey: VAULT,
        sleepClock: sleep.port,
        fs: vault.fs,
        markdown: remarkMarkdown,
        thisMacId: THIS_MAC,
        paused: () => false,
        pausedNow: false,
        clock: pullClock,
        activity,
        // GitHub holds what this Mac's settings hold: no claim waits to be pushed.
        gitOf: () => githubHolding(() => SETTINGS),
        onClaimUnshared: () => undefined,
      });
      useMeetingImport({
        changes,
        ports: vault.ports,
        clock: importClock,
        activity,
        vaultKey: VAULT,
        selfName: null,
        selfEmails: [],
        ownerKnown: true,
        active: true,
        indexReady,
        pulledFiles: gate,
        namedElsewhere: null,
        onWaiting: () => undefined,
        onWritten,
      });
      return pulls;
    },
    { initialProps: { indexReady: false } },
  );
  // The index reads the vault, then is ready: the import catches up only after it has seen it work.
  hook.rerender({ indexReady: true });
  /** A pull, or a look that found nothing new, started and completed with the Mac awake. */
  const pullCompletes = async () => {
    const pulls = hook.result.current;
    const startedAsleepMs = await pulls.readAsleep();
    await act(async () => {
      pulls.started(VAULT);
      await pulls.ended(VAULT, { kind: 'synced' }, startedAsleepMs);
    });
  };
  return { hook, changes, pullCompletes, activity };
}

async function settled(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('adversarial #174: sleep between the gate and the write', () => {
  /**
   * The importer asks the gate once per run, then writes file after file. A
   * catch-up over Inbox/Meetings is one run: if the Mac sleeps partway
   * through it (the lid closes), it wakes and goes on stamping the rest
   * before any pull — the stale-named-Mac race (H7) the gate exists to
   * close. Another Mac may have claimed and imported them meanwhile.
   */
  it('writes into no meeting file after the Mac slept partway through a catch-up, until a pull after the wake', async () => {
    const first = 'Inbox/Meetings/2026-10-14 Standup.md';
    const second = 'Inbox/Meetings/2026-10-14 Planning.md';
    const vault = vaultWith({
      [first]: { text: BROKEN_TEXT, modified: 1 },
      [second]: { text: BROKEN_TEXT, modified: 1 },
    });
    const sleep = fakeSleepClock();
    let slept = false;
    // The lid closes as the catch-up reads its first file; the Mac sleeps eight hours.
    vault.whenRead(() => {
      if (slept) return;
      slept = true;
      sleep.sleep(8 * 60 * 60_000);
    });
    const { pullCompletes } = wire({ vault, sleep, now: () => 1_000 });

    await pullCompletes();
    await waitFor(() => expect(slept).toBe(true));
    await settled();

    // Awake again, no pull since the wake: nothing may be written.
    expect(vault.written).toEqual([]);
  });
});

describe('adversarial #174: gate 1 (a pull completed after the file arrived)', () => {
  /**
   * #174's acceptance criteria: the import acts only when BOTH gates hold —
   * gate 1, "the last completed pull finished later than the file's modified
   * time on this Mac". A meeting this Mac's own Granola pull wrote after its
   * last git pull fails gate 1: another Mac may have claimed since, and the
   * next pull would show it. The PR keeps gate 1 for #175's count only.
   */
  it('imports nothing from a meeting file modified on this Mac after its last completed pull', async () => {
    const arrived = 'Inbox/Meetings/2026-10-14 Planning.md';
    const meetings: Record<string, { text: string; modified: number }> = {};
    const vault = vaultWith(meetings);
    const sleep = fakeSleepClock();
    let now = 1_000;
    const { pullCompletes, changes } = wire({ vault, sleep, now: () => now });

    // The pull completes at 1 000 with Inbox/Meetings empty; this Mac's
    // Granola pull writes the meeting at 5 000, with no git pull since.
    await pullCompletes();
    await settled();
    meetings[arrived] = { text: BROKEN_TEXT, modified: 5_000 };
    now = 6_000;
    changes.publish({
      vault: VAULT,
      changes: [{ kind: 'added', path: arrived, type: 'meeting', digest: 'd' }],
    });
    await settled();

    expect(vault.written).toEqual([]);
  });
});

describe('adversarial #174: the catch-up after every pull', () => {
  /**
   * The import now catches up after every completed sync or look, and a look
   * runs every pull interval (1 minute by default). A file the catch-up can
   * never settle — a sync-conflict copy of a meeting — is said in Activity
   * on each one. The log leaves out only a repeat within a minute
   * (ACTIVITY_REPEAT_MS), so one conflict copy is a new warning every
   * minute, all day. Before #174 it was said once per vault opened.
   */
  it('says a conflict copy waiting in Inbox/Meetings once, not once per look', async () => {
    const copy = 'Inbox/Meetings/2026-10-14 Standup (conflict from Laptop).md';
    const vault = vaultWith({ [copy]: { text: BROKEN_TEXT, modified: 1 } });
    const sleep = fakeSleepClock();
    let now = Date.parse('2026-10-14T09:00:00Z');
    const store = memoryActivityStore();
    const activity = createActivityLog({
      store,
      clock: { now: () => now },
      vault: () => VAULT,
      schedule: () => undefined,
      onError: () => undefined,
    });
    const { pullCompletes } = wire({ vault, sleep, now: () => now, activity });

    // Five looks at GitHub, a minute apart, each finding nothing new.
    for (let look = 0; look < 5; look += 1) {
      await pullCompletes();
      await settled();
      now += 60_000;
    }
    const said = (await activity.read()).filter((event) =>
      event.message.includes("another Mac's version of a meeting both changed"),
    );

    expect(said).toHaveLength(1);
  });
});
