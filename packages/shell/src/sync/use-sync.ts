import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PULL_INTERVAL_MINUTES,
  DEFAULT_PUSH_DELAY_SECONDS,
  runsAutomationsHere,
  type ClaimOutcome,
  type SyncPhase,
} from '@dfai/domain';
import {
  saveSyncSettings,
  syncSettingsOf,
  type ActivityLog,
  type Clock,
  type GitFoldersPort,
  type GitHubPort,
  type GitPort,
  type MarkdownPort,
  type SyncFilesPort,
  type SyncRemoteChoice,
  type SyncSettings,
  type SyncTimingChanges,
  type SleepClockPort,
  type SyncSetup,
  type ThisMacPort,
  type VaultFsPort,
  type WindowClosingPort,
} from '@dfai/application';
import { useVaultSetting } from '../settings/use-vault-setting.ts';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';
import type { SyncPauseStore } from './browser-sync-pause.ts';
import { useClaimAutomations } from './use-claim-automations.ts';
import { usePhase } from './use-phase.ts';
import { usePulledFiles, type PulledFilesGate } from './use-pulled-files.ts';
import { useExclusive, useInspection, useSyncRuns, type ThisMac } from './use-sync-runs.ts';
import { useSyncSchedule } from './use-sync-schedule.ts';
import type { IndexNewsFeed } from '../reads/use-scoped-index-news.ts';
import { useRepositories, useSetUp, type RepositoryList } from './use-sync-setup.ts';

/** The host's git, gh, the sync's own files, this Mac, its pause switch (U-29), and how long it has slept (#172). */
export interface SyncHostPorts {
  readonly git: (vault: string) => GitPort;
  readonly files: (vault: string) => SyncFilesPort;
  readonly folders: GitFoldersPort;
  readonly github: GitHubPort;
  readonly thisMac: ThisMacPort;
  readonly pause: SyncPauseStore;
  readonly sleepClock: SleepClockPort;
}

export interface SyncOptions {
  readonly host: SyncHostPorts;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  /** The open vault's root; null with none open. */
  readonly vaultKey: string | null;
  /**
   * Tells of each change to the vault's files — an edit, a move, a Claude
   * edit, an automation's run — as the index's news (`SYNC_SCOPE`), heard
   * without drawing the window (#326).
   */
  readonly edits: IndexNewsFeed;
  readonly clock: Pick<Clock, 'now' | 'localNow'>;
  readonly activity: Pick<ActivityLog, 'inVault' | 'inOpenVault'>;
  /** Writes every pane's unsaved typing. */
  readonly flushAll: () => Promise<void>;
  /** The window's close, which waits for the last sync. */
  readonly closing: WindowClosingPort;
  /** Re-reads the tree and the index once a sync has brought changes in. */
  readonly onPulled: () => void;
}

export interface SyncController {
  readonly phase: SyncPhase;
  readonly setup: SyncSetup | null;
  readonly thisMac: string | null;
  readonly settings: SyncSettings | null;
  /** Whether sync is paused on this Mac: nothing then runs by itself. */
  readonly paused: boolean;
  /** Other Macs' commits GitHub has that are not brought in yet. */
  readonly behind: number;
  /**
   * Whether the clock runs this vault's automations here: false until this
   * Mac's id and the settings are known, so a Mac never runs a rule the
   * settings give to another in the moment before it has read them.
   */
  readonly automationsHere: boolean;
  /**
   * The vaults that may take in files from elsewhere (ADR-0034): each has had
   * a sync pull from GitHub in this session of the app, or does not sync.
   */
  readonly syncedThisSession: ReadonlySet<string>;
  /**
   * How many syncs in this session of the app have brought other Macs' files
   * into each vault: each one leaves the index to catch up with them.
   */
  readonly syncPulls: ReadonlyMap<string, number>;
  /**
   * Whether this Mac may act on what sync brought into the open vault
   * (ADR-0035 part 4): sync is not paused here, a pull started since it last
   * slept has completed after the files to act on arrived, and the settings
   * can be read and name it, as read after that pull and as read now.
   */
  readonly pulledFiles: PulledFilesGate;
  /** Why setting up failed, to show beside the form. */
  readonly problem: string | null;
  /** The person's GitHub repositories, for the picker. */
  readonly repositories: RepositoryList;
  readonly loadRepositories: () => void;
  readonly setUp: (remote: SyncRemoteChoice) => void;
  readonly syncNow: () => void;
  readonly setPullInterval: (minutes: number) => void;
  readonly setPushDelay: (seconds: number) => void;
  readonly setPaused: (paused: boolean) => void;
  /** Settings → Sync: names this Mac as the one that runs the automations (ADR-0025). */
  readonly claimAutomations: () => void;
  /**
   * "Process here" on the Inbox (ADR-0035 part 2): the same claim, refused
   * while sync is paused, failing or has not pulled since launch or wake.
   */
  readonly processHere: () => Promise<ClaimOutcome>;
  /** Whether a claim of the automations is waiting for its turn or being written. */
  readonly claiming: boolean;
  /**
   * While this Mac's claim is written here and no sync has pushed it: the
   * name of the Mac it was taken from, which still believes it is named.
   */
  readonly claimPending: { readonly was: string | null } | null;
  /** Settles once any sync, or setting one up, under way has finished: another vault must not open under it. */
  readonly settle: () => Promise<void>;
}

/**
 * Sync for the open vault, wired to the host (U-29, A29-01): how it stands,
 * the syncs and looks at GitHub the schedule calls for, and the controls
 * Settings → Sync shows. One git run of the vault at a time — a sync, a
 * look, or setting one up; what is due and what a sync does are decided
 * below this.
 */
export function useSync(options: SyncOptions): SyncController {
  const { host, vaultKey } = options;
  const thisMac = useThisMac(host.thisMac);
  const settings = useSyncSettings(options);
  const [setup, setSetup] = useState<SyncSetup | null>(null);
  const { phase, setPhase, phaseNow } = usePhase();
  const [behind, setBehind] = useState(0);
  const { paused, setPaused } = usePause(host.pause, vaultKey);
  const git = useMemo(() => (vaultKey === null ? null : host.git(vaultKey)), [host, vaultKey]);
  const files = useMemo(() => (vaultKey === null ? null : host.files(vaultKey)), [host, vaultKey]);
  const exclusive = useExclusive(options.clock, vaultKey);
  const { syncedThisSession, syncPulls, markSynced } = useSyncedThisSession();
  const automationsHere =
    thisMac !== null &&
    settings.value !== null &&
    runsAutomationsHere({ automationsMac: settings.value.automationsMac, thisMacId: thisMac.id });
  const {
    gate: pulledFiles,
    pulls,
    claimRefusal,
    claimed,
    claimUnsharedNow,
    claimUnshared,
    claimWas,
    namedOnGitHub,
  } = usePulledFiles({
    vaultKey,
    sleepClock: host.sleepClock,
    fs: options.fs,
    markdown: options.markdown,
    thisMacId: thisMac?.id ?? null,
    paused: (vault) => host.pause.read(vault),
    pausedNow: paused,
    clock: options.clock,
    activity: options.activity,
    gitOf: host.git,
    // A claim a look found not on GitHub is pushed now, not at the next edit (#630 attack).
    onClaimUnshared: (vault) => {
      if (vault === vaultKey && !host.pause.read(vault)) void runNow.current();
    },
  });
  const shared = { ...options, git, files, thisMac, setPhase, markSynced, exclusive, pulls };
  const { run, check, lastSyncAt, lastCheckAt } = useSyncRuns({ ...shared, setBehind });
  const runNow = useRef(run);
  runNow.current = run;
  useInspection({
    ...shared,
    folders: host.folders,
    setSetup,
    setBehind,
    run,
    paused: () => host.pause.read(vaultKey ?? ''),
  });
  useSyncSchedule({
    enabled: setup?.kind === 'set-up',
    paused,
    pushDelaySeconds: settings.value?.pushDelaySeconds ?? null,
    pullIntervalMinutes: settings.value?.pullIntervalMinutes ?? null,
    edits: options.edits,
    clock: options.clock,
    lastSyncAt,
    lastCheckAt,
    closing: options.closing,
    run,
    check,
  });
  const { setUp, problem } = useSetUp({ ...shared, folders: host.folders, setSetup });
  const repositories = useRepositories(host.github);
  const { save } = settings;
  // After a restart only git knows of the claim: shown from what the gates found.
  const gitPending = useMemo(
    () => (claimUnshared ? { was: claimWas } : null),
    [claimUnshared, claimWas],
  );
  const claims = useClaimAutomations({
    named: automationsHere,
    fs: options.fs,
    markdown: options.markdown,
    vaultKey,
    thisMac,
    syncs: setup?.kind === 'set-up',
    paused,
    phaseNow,
    claimRefusal,
    claimed,
    claimUnsharedNow,
    namedOnGitHub,
    claimUnshared,
    exclusive,
    activity: options.activity,
    readAgain: settings.readAgain,
    run,
  });
  const claimPending = claims.pending ?? gitPending;
  return {
    phase,
    setup,
    thisMac: thisMac?.name ?? null,
    settings: settings.value,
    paused,
    behind,
    syncedThisSession,
    syncPulls,
    pulledFiles,
    automationsHere,
    problem: claims.problem ?? problem ?? settings.problem,
    repositories: repositories.list,
    loadRepositories: repositories.load,
    setUp,
    syncNow: useCallback(() => void run(), [run]),
    setPullInterval: useCallback(
      (minutes: number) => save({ pullIntervalMinutes: minutes }),
      [save],
    ),
    setPushDelay: useCallback((seconds: number) => save({ pushDelaySeconds: seconds }), [save]),
    setPaused,
    claimAutomations: claims.claimAutomations,
    processHere: claims.processHere,
    claiming: claims.claiming,
    claimPending,
    settle: exclusive.settle,
  };
}

/** This Mac's name and id, asked of the host and the app's storage once. */
function useThisMac(port: ThisMacPort): ThisMac | null {
  const [mac, setMac] = useState<ThisMac | null>(null);
  useEffect(() => {
    let live = true;
    // The host always answers; should it fail, "this Mac" still names it.
    const name = port.name().catch(() => 'this Mac');
    void Promise.all([name, port.id()]).then(
      ([found, id]) => live && setMac({ name: found, id }),
      (cause: unknown) => console.error('This Mac’s id could not be read:', cause),
    );
    return () => {
      live = false;
    };
  }, [port]);
  return mac;
}

/**
 * The vaults this session has synced, or found not to sync, and how many of
 * those syncs brought files in; never forgotten until the app quits.
 */
function useSyncedThisSession() {
  const [syncedThisSession, setSynced] = useState<ReadonlySet<string>>(() => new Set());
  const [syncPulls, setSyncPulls] = useState<ReadonlyMap<string, number>>(() => new Map());
  const markSynced = useCallback((vault: string, broughtIn = false) => {
    setSynced((known) => (known.has(vault) ? known : new Set([...known, vault])));
    if (broughtIn) setSyncPulls((known) => new Map(known).set(vault, (known.get(vault) ?? 0) + 1));
  }, []);
  return { syncedThisSession, syncPulls, markSynced };
}

/** The pause switch for the open vault, on this Mac. */
function usePause(store: SyncPauseStore, vaultKey: string | null) {
  const [paused, setState] = useState(() => vaultKey !== null && store.read(vaultKey));
  useEffect(() => setState(vaultKey !== null && store.read(vaultKey)), [store, vaultKey]);
  const setPaused = useCallback(
    (next: boolean) => {
      if (vaultKey !== null) store.write(vaultKey, next);
      setState(next);
    },
    [store, vaultKey],
  );
  return { paused, setPaused };
}

/**
 * The vault's sync settings, read from its settings note; its timing saved
 * through its one writer. Who runs the automations is changed by the claim
 * alone (`useClaimAutomations`), which reads them again once it has written.
 */
function useSyncSettings({ fs, markdown, vaultKey, activity }: SyncOptions) {
  const store = useCallback(
    ({ pullIntervalMinutes, pushDelaySeconds }: SyncSettings) =>
      saveSyncSettings({
        settings: vaultSettingsWriter({ fs, markdown }),
        changes: { pullIntervalMinutes, pushDelaySeconds },
      }),
    [fs, markdown],
  );
  const setting = useVaultSetting({
    fs,
    markdown,
    parse: syncSettingsOf,
    store,
    vaultKey,
    activity,
  });
  const { value, save: saveWhole } = setting;
  const save = useCallback(
    (changes: SyncTimingChanges) =>
      saveWhole({
        pullIntervalMinutes:
          changes.pullIntervalMinutes ??
          value?.pullIntervalMinutes ??
          DEFAULT_PULL_INTERVAL_MINUTES,
        pushDelaySeconds:
          changes.pushDelaySeconds ?? value?.pushDelaySeconds ?? DEFAULT_PUSH_DELAY_SECONDS,
        automationsMac: value?.automationsMac ?? null,
        automationsMacName: value?.automationsMacName ?? null,
      }),
    [saveWhole, value],
  );
  return {
    value,
    save,
    readAgain: setting.readAgain,
    problem: setting.problem ?? setting.unreadable,
  };
}
