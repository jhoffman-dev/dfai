import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  backoffMinutes,
  unavailableBackoffMinutes,
  dueTrigger,
  gatedByFreshPull,
  isAutomationPath,
  localTimeMs,
  localTimeOf,
  noteTitle,
  noteTriggerHears,
  ruleClockOf,
  type AutomationRule,
  type LocalTime,
  type LogEntry,
  type RunTrigger,
} from '@dfai/domain';
import {
  adoptAutomations,
  AutomationLogError,
  ClaudeUnavailableError,
  clockForRule,
  planNowOf,
  refreshBuiltInPrompts,
  waitsForPlanZone,
  HeldForPullError,
  loadAutomations,
  needsAdoption,
  NoteRunsCappedError,
  recordNewsLetGo,
  runAutomation,
  runOnMissedArrivals,
  runOnNoteChanges,
  undoLastRun,
  updateAutomation,
  VaultChangedError,
  type ActivityLog,
  type AutomationListing,
  type ModelProvider,
  type UnavailableFoundBy,
  type AutomationPorts,
  type NoteChangeNews,
  type NoteChanges,
  type RuleQueryPorts,
  type Clock,
  type VaultGuard,
} from '@dfai/application';
import { errorMessage } from '../query/error-message.ts';
import type { PulledFilesGate } from '../sync/use-pulled-files.ts';

/** How often the clock is checked for a rule that has come due, and the rules and logs read again. */
export const SCHEDULE_TICK_MS = 60_000;

/**
 * The most syncs' news held while rules cannot yet run on them — the index or
 * the rules still being read, this Mac not yet known to be the one that runs
 * them, or a rule paused — the oldest let go first. A run by hand then takes
 * what was let go, and what was let go is said: in Activity and in the log of
 * each rule it was held for, with how much, within the minute.
 */
export const HELD_NEWS = 20;

/**
 * What a rule a note sets off is holding to run on: one sync's news, or —
 * once, when its vault opens — the look for arrivals it never ran on
 * (`runOnMissedArrivals`), which waits its turn and is kept through a pause
 * as news is.
 */
type HeldNews = NoteChangeNews | { readonly vault: string; readonly missedArrivals: true };

export interface AutomationsOptions {
  /** The runner's ports, and the notes on screen, which the page's list and dry run read. */
  readonly ports: AutomationPorts & Pick<RuleQueryPorts, 'notePaths'>;
  readonly clock: Pick<Clock, 'today' | 'now' | 'localNow'>;
  /** The open vault's root; null with none open. */
  readonly vaultKey: string | null;
  /**
   * Moves with the index's news of the rules and their logs (`AUTOMATIONS_SCOPE`,
   * #326): while the page is open, a rule edited by hand is read again.
   */
  readonly indexKey: string;
  /** Rules are only run once the index can answer their queries. */
  readonly indexReady: boolean;
  /** Where each run and undo is said (U-28). */
  readonly activity: ActivityLog;
  /**
   * The plan zone the vault's settings keep (#587, ADR-0046): the morning
   * brief is counted and run on its clock. Null or left out, on the Mac's.
   */
  readonly planZone?: string | null;
  /**
   * Whether the vault's settings have been read, so `planZone` is known
   * (#587). Until they have, the brief's schedule waits: counted on the
   * Mac's clock meanwhile, it could brief a day early. Left out, read.
   */
  readonly planZoneRead?: boolean;
  /** Re-reads the tree and the index once a run or an edit has written. */
  readonly onSettled: () => void;
  /**
   * Whether the Automations page is on screen. Only then is the index's news
   * of the rules a reason to read them and their logs again; otherwise the
   * minute's tick is.
   */
  readonly live?: boolean;
  /**
   * Whether the clock runs rules on this Mac. A synced vault names one Mac for
   * its automations (U-29); on any other, rules still run by hand. Left out, it does.
   * The same holds for rules a note sets off (P29-01). Null while it is not yet
   * known: nothing runs, and what a note sets off is held until it is.
   */
  readonly scheduled?: boolean | null;
  /** Where every sync says which notes changed: what sets off a rule that waits for a note. */
  readonly changes?: NoteChanges;
  /**
   * Whether this Mac may run a Claude step on what sync brought in, and the
   * pull that says so (ADR-0035 part 4). A rule that waits on it
   * (`gatedByFreshPull`) is asked it as it fires and again before each
   * write: one a note sets off holds its news, and one the clock sets off
   * stays due, until it may — each pull that completes tries them again.
   * Left out, it may.
   */
  readonly pulledFiles?: Pick<PulledFilesGate, 'standing' | 'acts'>;
}

/**
 * Why a rule is not being run by the clock just now (A25-01): its log could
 * not be written — so a run would change notes nothing records — until it is
 * run by hand; or it keeps failing, and waits longer each time.
 */
export interface RulePause {
  readonly reason: string;
  readonly failures: number;
  /** When the clock may try it again; null until it is run by hand. */
  readonly retryAt: LocalTime | null;
  /**
   * Set when its Claude step could not reach Claude (#182): why, as its log
   * says it — what the Mac that runs the automations says until it runs.
   */
  readonly unavailable?: string;
  /**
   * How that was found: by the status, which the tick asks again and lets
   * the pause go when it says ready; or by a refused ask, which the status
   * cannot see end, so the pause keeps its backoff (#637 attack).
   */
  readonly unavailableBy?: UnavailableFoundBy;
}

/** The vault's automations as last read, and which vault they were read from. */
interface Read {
  readonly vault: string;
  readonly listing: AutomationListing;
  /** The command count it was read after: older, and a run it has not seen may be missing from it. */
  readonly revision: number;
  /** The tick it was read on: the clock only acts on rules read this minute. */
  readonly tick: number;
}

type Exclusive = <Result>(
  task: (vault: string) => Promise<Result>,
  options?: { wait?: boolean },
) => Promise<Result | null>;

/**
 * The vault's automations, and the one runner that carries them out — on
 * their schedule, when the vault opens, or when asked (P25-02).
 *
 * The timer lives here, at the edge, where the clock is: whether a rule is
 * due is the domain's to say, and what a run does is the use-case's. One run
 * at a time, so a scheduled run never plans against notes a hand-started one
 * is still moving.
 */
export function useAutomations(options: AutomationsOptions) {
  const { ports, clock, vaultKey, onSettled, activity } = options;
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [tick, setTick] = useState(0);
  const pending = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const openVault = useRef(vaultKey);
  openVault.current = vaultKey;
  // When this vault was opened: what a rule with no log counts its first run from.
  const watchingSince = useMemo<LocalTime | null>(
    () => (vaultKey === null ? null : clock.localNow()),
    [vaultKey, clock],
  );
  const pauses = usePauses(vaultKey, clock);
  // The morning brief keeps the calendar's clock (#587): read when a run's turn comes.
  const planZone = options.planZone ?? null;
  const planZoneNow = useRef(planZone);
  planZoneNow.current = planZone;
  const planZoneReadNow = useRef(options.planZoneRead ?? true);
  planZoneReadNow.current = options.planZoneRead ?? true;

  useListing({ ...options, revision, tick, setRead, setError });

  useEffect(() => {
    if (vaultKey === null) return;
    const timer = setInterval(() => setTick((count) => count + 1), SCHEDULE_TICK_MS);
    return () => clearInterval(timer);
  }, [vaultKey]);

  /**
   * Runs one command on the vault's rules; reads them again after. A command
   * asked for while another is under way is refused — unless it waits its
   * turn, as a save from the editor does, which must never simply vanish.
   */
  const exclusive: Exclusive = useCallback(
    async (task, { wait = false } = {}) => {
      if (openVault.current === null || (pending.current > 0 && !wait)) return null;
      pending.current += 1;
      const previous = queue.current;
      let release = () => {};
      queue.current = new Promise<void>((resolve) => (release = resolve));
      setBusy(true);
      try {
        await previous;
        const vault = openVault.current;
        return vault === null ? null : await task(vault);
      } catch (cause) {
        setNotice(errorMessage(cause));
        return null;
      } finally {
        pending.current -= 1;
        release();
        if (pending.current === 0) setBusy(false);
        setRevision((count) => count + 1);
        onSettled();
      }
    },
    [onSettled],
  );

  const { clear: clearPause, record: recordFailure, isUnavailable } = pauses;
  const recheck = useClaudeRecheck({
    tick,
    pauses,
    provider: () => ports.claude.provider(),
    scheduled: options.scheduled,
  });
  // Read when a queued run's turn comes, not when it was queued.
  const runsHere = useRef(options.scheduled ?? true);
  runsHere.current = options.scheduled ?? true;
  const guardOf = useCallback(
    (vault: string): VaultGuard => ({ vault, currentVault: () => openVault.current }),
    [],
  );
  const gate = useRef(options.pulledFiles?.acts);
  gate.current = options.pulledFiles?.acts;
  /** The gates of a fresh pull for the vault's notes, as a run asks them before it acts and writes. */
  const freshPullOf = useCallback(
    (vault: string) => async (paths: readonly string[]) =>
      (await gate.current?.(vault, { paths })) ?? true,
    [],
  );
  /** Whether the rule may run now: one that waits on the gates (`gatedByFreshPull`) only while they are open. */
  const mayActOn = useCallback(
    async (rule: AutomationRule, vault: string, trigger: RunTrigger) =>
      !gatedByFreshPull({ rule, trigger }) || (await (gate.current?.(vault) ?? true)),
    [],
  );
  // The rules whose last run was held for the next pull, having done nothing.
  const heldForPull = useRef(new Set<string>());
  /**
   * Runs a rule through the one door: a failure pauses it, as the clock's
   * backoff says; success clears that. One held for the next pull neither
   * failed nor ran: it settles with null, and `heldForPull` holds its id.
   */
  const forRule = useCallback(
    (
      rule: AutomationRule,
      carryOut: (vault: string) => Promise<LogEntry | null>,
      options?: { wait?: boolean },
    ) =>
      exclusive(async (vault) => {
        heldForPull.current.delete(rule.id);
        try {
          const entry = await carryOut(vault);
          // Run now that fails while Claude is out of reach leaves the pause, and its warning, as they are.
          if (!(entry?.kind === 'failed' && isUnavailable(rule.id))) clearPause(rule.id);
          return entry;
        } catch (cause) {
          if (cause instanceof HeldForPullError) {
            heldForPull.current.add(rule.id);
            return null;
          }
          recordFailure(rule.id, cause);
          throw cause;
        }
      }, options),
    [exclusive, clearPause, recordFailure, isUnavailable],
  );
  const runRule = useCallback(
    (rule: AutomationRule, trigger: RunTrigger) =>
      forRule(rule, (vault) =>
        runAutomation({
          ports,
          rule,
          clock: clockForRule({ rule, clock, planZone: planZoneNow.current }),
          activity,
          trigger,
          guard: guardOf(vault),
          freshPull: freshPullOf(vault),
        }),
      ),
    [forRule, guardOf, ports, clock, activity, freshPullOf],
  );
  /**
   * Runs a rule on one sync's news; settles false when the run failed, so the
   * news is held for its retry. It waits its turn behind a command under way,
   * and is guarded by the vault the news was heard in, not the one open when
   * its turn comes: another vault opened meanwhile stops it, and the news goes.
   */
  const runOnNotes = useCallback(
    async (rule: AutomationRule, news: HeldNews): Promise<boolean> => {
      let failed = false;
      const carryOut = async () => {
        // Its turn may come after this Mac is found not to run the vault's automations.
        if (runsHere.current !== true) return null;
        // Or after a sleep, or during a pull: then the news waits for the next pull.
        if (!(await mayActOn(rule, news.vault, 'note'))) throw new HeldForPullError();
        const run = {
          ports,
          rule,
          clock,
          activity,
          guard: guardOf(news.vault),
          freshPull: freshPullOf(news.vault),
        };
        try {
          return 'missedArrivals' in news
            ? await runOnMissedArrivals(run)
            : await runOnNoteChanges({ ...run, changes: news.changes });
        } catch (cause) {
          failed = !(cause instanceof VaultChangedError) && !(cause instanceof HeldForPullError);
          throw cause;
        }
      };
      await forRule(rule, carryOut, { wait: true });
      return !failed && !heldForPull.current.has(rule.id);
    },
    [forRule, guardOf, ports, clock, activity, runsHere, mayActOn, freshPullOf],
  );

  /** Says, in Activity and the rule's log, that the rule let go of news it was holding. */
  const sayLetGo = useCallback(
    (rule: AutomationRule, count: number) =>
      void exclusive(
        (vault) => recordNewsLetGo({ ports, rule, clock, activity, count, guard: guardOf(vault) }),
        { wait: true },
      ),
    [exclusive, guardOf, ports, clock, activity],
  );

  const undo = useCallback(
    (rule: AutomationRule) =>
      exclusive((vault) =>
        undoLastRun({
          ports,
          rule,
          clock,
          activity,
          guard: { vault, currentVault: () => openVault.current },
        }),
      ),
    [exclusive, ports, clock, activity],
  );

  const setEnabled = useCallback(
    (rule: AutomationRule, enabled: boolean) =>
      exclusive(() =>
        updateAutomation({
          fs: ports.fs,
          markdown: ports.markdown,
          clock,
          rule,
          draft: { ...rule, enabled },
        }),
      ),
    [exclusive, ports, clock],
  );

  const current = read !== null && read.vault === vaultKey ? read.listing : null;
  // Only rules read this minute, since the last command, are run by the clock: a listing
  // from before a run does not know it ran, and would run it again.
  const fresh = read?.revision === revision && read.tick === tick ? current : null;
  useSchedule({
    ...options,
    listing: fresh,
    tick,
    watchingSince,
    runRule,
    exclusive,
    isPaused: pauses.isPaused,
    mayActOn,
    heldForPull,
    planZoneNow,
    planZoneReadNow,
  });
  useNoteRuns({
    ...options,
    listing: current,
    tick,
    recheck,
    runOnNotes,
    sayLetGo,
    isPaused: pauses.isPaused,
    mayActOn,
  });

  return {
    listing: current,
    error,
    busy,
    notice,
    setNotice,
    watchingSince,
    /** The plan zone the vault keeps, which the morning brief is counted on; null for none (#587). */
    planZone,
    /** Rules the clock is not running just now, by id, and why. */
    pauses: pauses.all,
    /** Runs a rule now, by hand; settles with its log entry, or null when it did not run. */
    runNow: useCallback((rule: AutomationRule) => runRule(rule, 'hand'), [runRule]),
    undo,
    /** Turns a rule on or off, in its file; turning one on is logged, so its schedule counts from then. */
    setEnabled,
    /** Writes to the vault's rules — a save, turning one on — through the same one-at-a-time door. */
    exclusive,
  };
}

/** Paused rules by id, and the vault they were paused in. */
interface VaultPauses {
  readonly vault: string | null;
  readonly byId: ReadonlyMap<string, RulePause>;
}

const NO_PAUSES: ReadonlyMap<string, RulePause> = new Map();

/**
 * The rules the clock has stopped running, kept for the vault open now. They
 * carry their vault: on the render a switch arrives, before any effect has
 * cleared them, the last vault's pauses are not this one's.
 */
function usePauses(vaultKey: string | null, clock: Pick<Clock, 'localNow'>) {
  const [held, setHeld] = useState<VaultPauses>({ vault: vaultKey, byId: NO_PAUSES });
  const all = held.vault === vaultKey ? held.byId : NO_PAUSES;
  const latest = useRef(all);
  latest.current = all;

  // Coming back to a vault starts it afresh, as opening it does.
  useEffect(() => {
    setHeld({ vault: vaultKey, byId: NO_PAUSES });
  }, [vaultKey]);

  const change = useCallback(
    (next: (byId: ReadonlyMap<string, RulePause>) => ReadonlyMap<string, RulePause>) => {
      setHeld((pauses) => ({ vault: pauses.vault, byId: next(pauses.byId) }));
    },
    [],
  );

  const clear = useCallback(
    (id: string) => {
      change((pauses) => {
        if (!pauses.has(id)) return pauses;
        const next = new Map(pauses);
        next.delete(id);
        return next;
      });
    },
    [change],
  );

  const record = useCallback(
    (id: string, cause: unknown) => {
      // Another vault was opened: the run was cut off, and the rule is not at fault.
      if (cause instanceof VaultChangedError) return;
      change((pauses) =>
        new Map(pauses).set(id, pauseAfter(pauses.get(id), cause, clock.localNow())),
      );
    },
    [change, clock],
  );

  const isPaused = useCallback((id: string, now: LocalTime) => {
    const pause = latest.current.get(id);
    return pause !== undefined && (pause.retryAt === null || now < pause.retryAt);
  }, []);

  /** Whether the rule is held back because its Claude step could not reach Claude (#182). */
  const isUnavailable = useCallback(
    (id: string) => latest.current.get(id)?.unavailable !== undefined,
    [],
  );

  return { all, clear, record, isPaused, isUnavailable };
}

/**
 * Asks again at each tick whether Claude can be reached, while a rule is held
 * back because it could not (#182, the PR #637 review): asking is local and
 * asks Claude nothing. Once it can, those pauses go and their news runs at
 * once, rather than when the backoff ends. Once this Mac no longer runs the
 * automations, such a pause is dropped: it says nothing of the Mac named next.
 * Answers with a count that moves each time it let pauses go.
 */
function useClaudeRecheck({
  tick,
  pauses,
  provider,
  scheduled,
}: {
  tick: number;
  pauses: Pick<ReturnType<typeof usePauses>, 'all' | 'clear'>;
  provider: () => Pick<ModelProvider, 'status'>;
  scheduled: boolean | null | undefined;
}): number {
  const [letGo, setLetGo] = useState(0);
  const { all, clear } = pauses;
  const held = useRef(all);
  held.current = all;
  const ask = useRef(provider);
  ask.current = provider;

  useEffect(() => {
    const forClaude = [...held.current].filter(([, pause]) => pause.unavailable !== undefined);
    if (forClaude.length === 0) return;
    if (scheduled === false) {
      for (const [id] of forClaude) clear(id);
      return;
    }
    // Only what the status found can the status say is over.
    const waiting = forClaude.flatMap(([id, pause]) =>
      pause.unavailableBy === 'status' ? [id] : [],
    );
    if (waiting.length === 0) return;
    let cancelled = false;
    ask
      .current()
      .status()
      .then(
        (status) => {
          if (cancelled || !status.ready) return;
          for (const id of waiting) clear(id);
          setLetGo((count) => count + 1);
        },
        () => {
          // Safe to ignore: the next tick asks again, and the backoff's own end still tries.
        },
      );
    return () => {
      cancelled = true;
    };
  }, [tick, scheduled, clear]);

  return letGo;
}

/** A rule's pause after one more failure. */
function pauseAfter(previous: RulePause | undefined, cause: unknown, now: LocalTime): RulePause {
  // Held by the hourly cap, it is not failing: it waits for the hour, and counts no failure.
  if (cause instanceof NoteRunsCappedError) {
    return {
      reason: `Held back: ${cause.message}`,
      failures: previous?.failures ?? 0,
      retryAt: cause.until,
    };
  }
  const failures = (previous?.failures ?? 0) + 1;
  if (cause instanceof AutomationLogError) {
    return {
      reason: `Paused: ${cause.message} Run it by hand to try again.`,
      failures,
      retryAt: null,
    };
  }
  const unavailable = cause instanceof ClaudeUnavailableError;
  // Out of reach, Claude is asked after again at each tick too: the wait is only a safety net.
  const minutes = unavailable ? unavailableBackoffMinutes(failures) : backoffMinutes(failures);
  const retryAt = localTimeOf((localTimeMs(now) ?? 0) + minutes * 60_000);
  return {
    reason: `Could not run (${errorMessage(cause)}); it is tried again at ${retryAt.slice(11, 16)}.`,
    failures,
    retryAt,
    ...(unavailable && { unavailable: cause.entry.problem, unavailableBy: cause.foundBy }),
  };
}

/**
 * Reads the vault's rules when the vault, its rule files, a command or the
 * minute changes them — and, while the page is open, whenever the index has
 * news of them. Not on every note saved elsewhere: a vault with many rules
 * would read every rule and every log each time.
 */
function useListing({
  ports,
  vaultKey,
  indexKey,
  live = false,
  revision,
  tick,
  setRead,
  setError,
}: AutomationsOptions & {
  revision: number;
  tick: number;
  setRead: (read: Read | null) => void;
  setError: (error: string | null) => void;
}) {
  const { fs, markdown, notePaths } = ports;
  // Keyed by the rule files alone, so a keystroke in another note reads nothing.
  const rulesKey = notePaths.filter(isAutomationPath).join('\n');
  const liveKey = live ? indexKey : '';
  useEffect(() => {
    if (vaultKey === null) {
      setRead(null);
      return;
    }
    let cancelled = false;
    loadAutomations({ fs, markdown, notePaths: rulesKey === '' ? [] : rulesKey.split('\n') })
      .then((listing) => {
        if (cancelled) return;
        setRead({ vault: vaultKey, listing, revision, tick });
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [fs, markdown, rulesKey, vaultKey, liveKey, revision, tick, setRead, setError]);
}

/**
 * Runs every rule that is due: once when a vault's rules are first read with
 * its index ready — a rule that runs on opening, and any schedule missed while
 * DFAI was closed — then on each minute's fresh read. Rules it has not taken
 * in yet are taken in first: given their id, and a first mark to count from.
 */
function useSchedule({
  ports,
  vaultKey,
  indexReady,
  clock,
  listing,
  tick,
  watchingSince,
  runRule,
  exclusive,
  isPaused,
  mayActOn,
  heldForPull,
  pulledFiles,
  activity,
  planZoneNow,
  planZoneReadNow,
  scheduled = true,
}: AutomationsOptions & {
  listing: AutomationListing | null;
  tick: number;
  watchingSince: LocalTime | null;
  runRule: (rule: AutomationRule, trigger: RunTrigger) => Promise<LogEntry | null>;
  exclusive: Exclusive;
  isPaused: (id: string, now: LocalTime) => boolean;
  mayActOn: (rule: AutomationRule, vault: string, trigger: RunTrigger) => Promise<boolean>;
  heldForPull: { readonly current: ReadonlySet<string> };
  /** The plan zone the vault keeps, as of this tick. */
  planZoneNow: { readonly current: string | null };
  /** Whether the settings that keep the plan zone have been read, as of this tick. */
  planZoneReadNow: { readonly current: boolean };
}) {
  const opened = useRef<string | null>(null);
  const checked = useRef<{ key: string; standing: unknown } | null>(null);
  // Rules that run on opening the vault, held for its first pull: they run on it once that completes.
  const openingHeld = useRef(new Set<string>());
  const { fs, markdown } = ports;
  // Each pull that completes may let a rule held for it run.
  const standing = pulledFiles?.standing;

  useEffect(() => {
    if (!scheduled) return;
    if (vaultKey === null || !indexReady || listing === null || watchingSince === null) return;
    const key = `${vaultKey}\n${tick}`;
    if (checked.current?.key === key && checked.current.standing === standing) return;
    checked.current = { key, standing };
    const opening = opened.current !== vaultKey;
    if (opening) openingHeld.current = new Set();
    opened.current = vaultKey;
    void (async () => {
      if (opening) await refreshPrompts({ fs, activity });
      if (needsAdoption(listing, clock.localNow())) {
        await exclusive(() => adoptAutomations({ fs, markdown, clock, listing }));
      }
      for (const { rule, log } of listing.automations) {
        const now = clock.localNow();
        if (isPaused(rule.id, now)) continue;
        const onOpening = opening || openingHeld.current.has(rule.id);
        if (waitsForPlanZone({ rule, zoneRead: planZoneReadNow.current })) {
          // Its turn on opening is kept for a tick once the zone is known.
          if (onOpening) openingHeld.current.add(rule.id);
          continue;
        }
        const planNow = planNowOf(clock, planZoneNow.current);
        const counted = ruleClockOf({ rule, now, watchingSince, planNow });
        const trigger = dueTrigger({ rule, log, ...counted, opening: onOpening });
        if (trigger === null) continue;
        // A Claude step waits for fresh sync state: a schedule due now is due still once a pull
        // completes, and one that runs on opening is kept for it.
        const held =
          !(await mayActOn(rule, vaultKey, trigger)) ||
          ((await runRule(rule, trigger)) === null && heldForPull.current.has(rule.id));
        if (trigger !== 'open') continue;
        if (held) openingHeld.current.add(rule.id);
        else openingHeld.current.delete(rule.id);
      }
    })();
  }, [
    vaultKey,
    indexReady,
    listing,
    tick,
    watchingSince,
    clock,
    fs,
    markdown,
    exclusive,
    runRule,
    isPaused,
    scheduled,
    mayActOn,
    heldForPull,
    standing,
    activity,
    planZoneNow,
    planZoneReadNow,
  ]);
}

/**
 * Brings the prompts DFAI ships up to date where they are untouched (#226),
 * once each time the vault is opened on the Mac that runs its automations,
 * and says so in Activity, a failure too: the rules still run as they are.
 * Not one of the runner's commands: it writes no rule, and one that wrote
 * nothing must not have the vault read again.
 */
async function refreshPrompts({
  fs,
  activity,
}: {
  fs: AutomationPorts['fs'];
  activity: ActivityLog;
}): Promise<void> {
  const recorder = activity.inOpenVault();
  try {
    for (const path of await refreshBuiltInPrompts({ fs })) {
      recorder.record({
        level: 'info',
        kind: 'automation',
        message: `Brought ${noteTitle(path)}, a prompt DFAI ships that was never edited, up to date.`,
        subject: { kind: 'note', path },
      });
    }
  } catch (cause) {
    recorder.record({
      level: 'warning',
      kind: 'automation',
      message: `The prompts DFAI ships could not be brought up to date: ${errorMessage(cause)}`,
      subject: null,
    });
  }
}

/**
 * Runs the rules a note sets off (P29-01) on every sync's news of what
 * changed. News is held until it can be acted on — the index ready, the
 * vault's rules read, this Mac known to be the one that runs them — and news
 * of a vault no longer open is let go; on a Mac known not to run the vault's
 * automations, it is not kept at all.
 *
 * Each rule that hears the news queues it, and runs its queue in turn, one
 * sync at a time. A run that fails keeps its news at the head of the queue,
 * and the rule's pause stands; each minute, a rule whose pause has ended runs
 * on what it was holding. Whether it already handled a version, and what it
 * does, is the use-case's to say.
 *
 * News is heard in memory, so what a rule was holding when DFAI was quit is
 * gone. Once per vault opened, each rule a note being created sets off is
 * queued a look for the arrivals it never ran on (ADR-0028, "Catching up
 * when DFAI opens"), ahead of this session's news.
 *
 * A queue holds {@link HELD_NEWS}; past that the oldest is let go, and that
 * is said — counted as it happens, and told each minute, so a burst is one
 * line and not one per sync.
 */
function useNoteRuns({
  changes,
  vaultKey,
  indexReady,
  clock,
  listing,
  tick,
  recheck,
  runOnNotes,
  sayLetGo,
  isPaused,
  mayActOn,
  scheduled = true,
  pulledFiles,
}: AutomationsOptions & {
  listing: AutomationListing | null;
  tick: number;
  /** Moves when pauses for Claude were let go: their news runs then, not at the next tick. */
  recheck: number;
  runOnNotes: (rule: AutomationRule, news: HeldNews) => Promise<boolean>;
  sayLetGo: (rule: AutomationRule, count: number) => void;
  isPaused: (id: string, now: LocalTime) => boolean;
  mayActOn: (rule: AutomationRule, vault: string, trigger: RunTrigger) => Promise<boolean>;
}) {
  const incoming = useRef<NoteChangeNews[]>([]);
  const queues = useRef(new Map<string, HeldNews[]>());
  const letGo = useRef<LetGo>({ unheard: 0, byRule: new Map(), saidAt: tick });
  const caughtUp = useRef<string | null>(null);
  const running = useRef(new Set<string>());
  const rules = useRef(listing);
  rules.current = listing;
  const [heard, setHeard] = useState(0);

  useEffect(() => {
    if (changes === undefined) return;
    return changes.subscribe((news) => {
      const held = [...incoming.current, news];
      incoming.current = held.slice(-HELD_NEWS);
      letGo.current.unheard += held.length - incoming.current.length;
      setHeard((count) => count + 1);
    });
  }, [changes]);

  // What waited for one vault is not the next one's.
  useEffect(() => {
    queues.current = new Map();
    letGo.current = { unheard: 0, byRule: new Map(), saidAt: letGo.current.saidAt };
  }, [vaultKey]);

  const runQueue = useCallback(
    async (id: string) => {
      if (running.current.has(id)) return;
      running.current.add(id);
      try {
        await runHeldNews({
          id,
          queues: () => queues.current,
          rules: () => rules.current,
          runOnNotes,
          // Asked before its turn as well, so news held for a pull waits outside the runner.
          mayRun: async (rule, news) =>
            !isPaused(id, clock.localNow()) && (await mayActOn(rule, news.vault, 'note')),
        });
      } finally {
        running.current.delete(id);
      }
    },
    [runOnNotes, isPaused, clock, mayActOn],
  );
  // Each pull that completes may let held news run.
  const standing = pulledFiles?.standing;

  useEffect(() => {
    if (scheduled === false) {
      // Named again later — "Process here" or Settings → Sync alike — the missed
      // arrivals are caught up again (ADR-0035, "Catch-up on a claim").
      caughtUp.current = null;
      incoming.current = [];
      queues.current = new Map();
      letGo.current = { unheard: 0, byRule: new Map(), saidAt: tick };
      return;
    }
    if (scheduled !== true || vaultKey === null || !indexReady || listing === null) return;
    const news = incoming.current.filter((each) => each.vault === vaultKey);
    incoming.current = [];
    const noteRules = listing.automations
      .map(({ rule }) => rule)
      .filter((rule) => rule.enabled && rule.when.kind === 'note');
    // News let go before any rule could hear it may have been any of theirs.
    for (const rule of noteRules) countLetGo(letGo.current, rule.id, letGo.current.unheard);
    letGo.current.unheard = 0;
    if (caughtUp.current !== vaultKey) {
      caughtUp.current = vaultKey;
      for (const rule of noteRules) {
        if (rule.when.kind !== 'note' || !rule.when.on.includes('created')) continue;
        queues.current.set(rule.id, [{ vault: vaultKey, missedArrivals: true }]);
      }
    }
    for (const [id, count] of queueByRule(queues.current, listing, news)) {
      countLetGo(letGo.current, id, count);
    }
    if (letGo.current.saidAt !== tick) {
      letGo.current.saidAt = tick;
      for (const [id, count] of letGo.current.byRule) {
        const rule = noteRules.find((each) => each.id === id);
        if (rule !== undefined) sayLetGo(rule, count);
      }
      letGo.current.byRule = new Map();
    }
    for (const id of queues.current.keys()) void runQueue(id);
  }, [
    heard,
    tick,
    recheck,
    scheduled,
    vaultKey,
    indexReady,
    listing,
    runQueue,
    sayLetGo,
    standing,
  ]);
}

/** News let go and not yet said: before any rule could hear it, and from each rule's queue; and the minute it was last said in. */
interface LetGo {
  unheard: number;
  byRule: Map<string, number>;
  saidAt: number;
}

function countLetGo(letGo: LetGo, id: string, count: number): void {
  if (count > 0) letGo.byRule.set(id, (letGo.byRule.get(id) ?? 0) + count);
}

/**
 * Adds each sync's news to the queue of every rule a note sets off that hears
 * it; answers with how much each queue let go to stay within {@link HELD_NEWS}.
 */
export function queueByRule(
  queues: Map<string, HeldNews[]>,
  listing: AutomationListing,
  news: readonly NoteChangeNews[],
): Map<string, number> {
  const letGo = new Map<string, number>();
  for (const each of news) {
    for (const { rule } of listing.automations) {
      if (!rule.enabled || rule.when.kind !== 'note') continue;
      if (!noteTriggerHears(rule.when, each.changes)) continue;
      const { marker, news: waiting } = withoutMarker([...(queues.get(rule.id) ?? []), each]);
      const kept = waiting.slice(-HELD_NEWS);
      queues.set(rule.id, [...marker, ...kept]);
      if (waiting.length > kept.length) {
        letGo.set(rule.id, (letGo.get(rule.id) ?? 0) + waiting.length - kept.length);
      }
    }
  }
  return letGo;
}

/** A queue split into its look for missed arrivals — which is no news and is never let go — and its news. */
function withoutMarker(queue: readonly HeldNews[]): {
  marker: readonly HeldNews[];
  news: readonly HeldNews[];
} {
  return {
    marker: queue.filter((held) => 'missedArrivals' in held),
    news: queue.filter((held) => !('missedArrivals' in held)),
  };
}

/**
 * Runs a rule's held news, oldest first, while it is not paused (each run
 * also checks, when its turn comes, that this Mac still runs the vault's
 * automations): each run that succeeds
 * lets its news go; one that fails keeps it, and stops. A rule gone, turned
 * off or no longer set off by notes lets its queue go. The queues are read
 * afresh each time round, so once they are let go — another vault opened,
 * or this Mac found not to run them — nothing more of them runs.
 */
async function runHeldNews({
  id,
  queues,
  rules,
  runOnNotes,
  mayRun,
}: {
  id: string;
  queues: () => Map<string, HeldNews[]>;
  rules: () => AutomationListing | null;
  runOnNotes: (rule: AutomationRule, news: HeldNews) => Promise<boolean>;
  mayRun: (rule: AutomationRule, news: HeldNews) => Promise<boolean>;
}): Promise<void> {
  for (let news = queues().get(id)?.[0]; news !== undefined; news = queues().get(id)?.[0]) {
    const rule = rules()?.automations.find((loaded) => loaded.rule.id === id)?.rule;
    if (rule === undefined || !rule.enabled || rule.when.kind !== 'note') {
      queues().delete(id);
      return;
    }
    if (!(await mayRun(rule, news))) return;
    if (!(await runOnNotes(rule, news))) return;
    const queue = queues().get(id) ?? [];
    if (queue[0] === news) queues().set(id, queue.slice(1));
  }
  if (queues().get(id)?.length === 0) queues().delete(id);
}
