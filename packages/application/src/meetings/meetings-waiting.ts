import {
  createVaultPath,
  failingWarningDue,
  isConflictCopyPath,
  isMeetingInboxPath,
  meetingsWaitingReport,
  NO_POST_PROCESSING,
  postProcessingFailingReport,
  touchesWaitingMeetings,
  waitingMacLabel,
  waitingMeetingTally,
  waitingWarningDue,
  type CountableStanding,
  type MeetingsWaiting,
  type NoteChange,
  type PostProcessingLedger,
  type VaultPath,
  type WaitingCountGate,
  type WaitingMeetingFile,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import { postProcessingMark } from '../automations/post-processing-ledger.ts';
import { meetingInboxNotes } from './meeting-inbox.ts';
import { readWaitingMeetings, type WaitingMeetingPorts } from './waiting-meeting-files.ts';

/**
 * What the importer is told of a Mac that is not named, so it says what
 * waits instead of dropping it without a word (ADR-0035 parts 1 and 3).
 */
export interface MeetingsWaitingWatch {
  /**
   * The named Mac's name as the settings keep it, when they name another Mac
   * than this one (by id); null when this Mac is named, or that is not known.
   */
  readonly namedElsewhere: (vault: string) => { readonly name: string | null } | null;
  /** Whether a count may be given now, and against which pull. */
  readonly countGate: (vault: string) => Promise<WaitingCountGate>;
  /** Told what waits each time it is judged anew: null when nothing is to be said, as on the named Mac. */
  readonly said: (vault: string, waiting: MeetingsWaiting | null) => void;
  /**
   * What the vault's rules that write summaries have finished with (#182),
   * from the rules already read; left out, no rule writes them.
   */
  readonly postProcessing?: (vault: string) => PostProcessingLedger;
  /**
   * On the Mac that runs the automations: why its own step could not reach
   * Claude, and the Mac's name, while it keeps failing so; null while it does
   * not. Left out, it never says so.
   */
  /**
   * Which of these meetings the rules that write summaries take, by their own
   * queries (#637 attack); `generation` moves whenever a meeting file has
   * changed. Null when the index cannot say. Left out, the count judges by
   * what each rule's `which` proves on its own.
   */
  readonly rulesTake?: (
    vault: string,
    asked: { readonly paths: readonly VaultPath[]; readonly generation: number },
  ) => Promise<PostProcessingLedger['taken'] | null>;
  readonly stepFailing?: (
    vault: string,
  ) => { readonly problem: string; readonly mac: string | null } | null;
}

/** What a counter is handed for each vault judged: its ports, and where its warning is said. */
export interface WaitingCounterRun {
  readonly ports: WaitingMeetingPorts;
  readonly activity: ActivityRecorder;
}

/**
 * Says what waits for the named Mac, on a Mac that is not named: the line
 * the Inbox shows, and Activity's warning when the count is news.
 */
export interface WaitingCounter {
  /** News of notes; whether it may change the count. The files it names are read when next judged. */
  heard(vault: string, changes: readonly NoteChange[]): boolean;
  /** What was last said for the vault; null when nothing was. */
  last(vault: string): MeetingsWaiting | null;
  /** Marks the files this Mac's import wrote or moved to be read again when next judged. */
  wrote(vault: string, paths: readonly VaultPath[]): void;
  /** Judges what waits now, says it, and warns when the count is news. */
  judge(vault: string, run: WaitingCounterRun): Promise<MeetingsWaiting | null>;
  /**
   * On the Mac that imports: says its step cannot reach Claude while it
   * keeps failing so, with how many meetings are pending, warning once per
   * failure; says nothing — reading nothing — while it does not.
   */
  judgeHere(
    vault: string,
    run: WaitingCounterRun,
    options?: {
      /**
       * Whether what it would judge may have moved: news named a meeting
       * file, or this is a catch-up or a recount. Left false, it judges
       * again only when the failure or the rules' ledger changed.
       */
      readonly fresh?: boolean;
    },
  ): Promise<MeetingsWaiting | null>;
}

/**
 * What the files where meetings land held when last read, for one vault: a
 * file listed and not read yet holds null. The folders are listed once; after
 * that, news says which files to read again (#627).
 */
interface Known {
  readonly vault: string;
  readonly files: Map<string, WaitingMeetingFile | null>;
}

/**
 * The folders are listed once per vault, and each file read once; news that
 * names a meeting file has that file alone read again, and a removed one
 * forgotten. Each judgement tallies what is known against the pull — so a
 * file left for the next pull is counted once that pull completes, and a
 * pull that brought nothing costs no listing and no read. While a pull is
 * under way, what was said stands.
 */
export function createWaitingCounter(watch: MeetingsWaitingWatch): WaitingCounter {
  let known: Known | null = null;
  let said: { vault: string; waiting: MeetingsWaiting | null } | null = null;
  // The counts warned of for each vault this session: Activity hears each count once.
  const warned = new Map<string, Set<number>>();
  // The failure last warned of for each vault while its step keeps failing: Activity hears each once.
  const warnedFailing = new Map<string, string>();
  // What the failing line was last judged on, for each vault: the failure and the rules' ledger.
  const judgedHere = new Map<string, string>();
  const ledgerOf = (vault: string) => watch.postProcessing?.(vault) ?? NO_POST_PROCESSING;
  // Moves whenever a meeting file changed, as news or this Mac's import says: what the rules take may have.
  let generation = 0;

  /**
   * The ledger with what the rules take among the meetings that could be
   * pending, asked of the index once a judgement — and only when a rule
   * writes summaries and some meeting could wait on it.
   */
  const ledgerWithTaken = async (
    vault: string,
    files: readonly WaitingMeetingFile[],
  ): Promise<PostProcessingLedger> => {
    const ledger = ledgerOf(vault);
    if (!ledger.summarising || watch.rulesTake === undefined) return ledger;
    const paths = files.filter(couldBePending).map(({ path }) => createVaultPath(path));
    if (paths.length === 0) return ledger;
    const taken = await watch.rulesTake(vault, { paths, generation });
    return taken === null || taken === undefined ? ledger : { ...ledger, taken };
  };

  const say = (vault: string, waiting: MeetingsWaiting | null) => {
    said = { vault, waiting };
    watch.said(vault, waiting);
    return waiting;
  };
  const last = (vault: string) => (said?.vault === vault ? said.waiting : null);

  /** What is known of the vault's files, listed if they are not known yet: one listing a vault. */
  const knownFor = async (vault: string, { ports }: WaitingCounterRun): Promise<Known> => {
    if (known?.vault === vault) return known;
    const listed = await meetingInboxNotes(ports.fs);
    known = { vault, files: new Map(listed.map((path) => [path, null])) };
    return known;
  };

  /** Reads every file listed or named by news since it was last read. */
  const readUnread = async (files: Known['files'], run: WaitingCounterRun) => {
    const unread = [...files]
      .filter(([, file]) => file === null)
      .map(([path]) => createVaultPath(path));
    for (const file of await readWaitingMeetings(run.ports, unread)) files.set(file.path, file);
  };

  const warnIfNews = (vault: string, run: WaitingCounterRun, waiting: CountedNow) => {
    const before = warned.get(vault) ?? new Set<number>();
    if (!waitingWarningDue({ ...waiting, warned: before })) return;
    const report = meetingsWaitingReport(waiting);
    if (report !== null) run.activity.record(report);
    warned.set(vault, new Set([...before, waiting.count]));
  };

  const count = async (
    vault: string,
    run: WaitingCounterRun,
    standing: CountableStanding,
  ): Promise<MeetingsWaiting | null> => {
    const { files } = await knownFor(vault, run);
    await readUnread(files, run);
    const read = [...files.values()].filter(isRead);
    const ledger = await ledgerWithTaken(vault, read);
    // The pull moved, the gates shut, or another Mac is no longer the one named, while the files were read.
    const after = await watch.countGate(vault);
    if (!after.open || after.standing !== standing) return last(vault);
    const named = watch.namedElsewhere(vault);
    if (named === null) return say(vault, null);
    const mac = waitingMacLabel(named.name);
    const tally = waitingMeetingTally(read, standing, ledger);
    warnIfNews(vault, run, { ...tally, mac });
    return say(vault, { kind: 'counted', mac, count: tally.count });
  };

  /** How many meetings' summaries and tasks are pending, under the gates; null while they are shut. */
  const pendingHere = async (
    vault: string,
    run: WaitingCounterRun,
  ): Promise<number | null | 'pulling'> => {
    const gate = await watch.countGate(vault);
    if (!gate.open) return gate.why === 'pulling' ? 'pulling' : null;
    const { files } = await knownFor(vault, run);
    await readUnread(files, run);
    const read = [...files.values()].filter(isRead);
    const ledger = await ledgerWithTaken(vault, read);
    const after = await watch.countGate(vault);
    if (!after.open || after.standing !== gate.standing) return 'pulling';
    return waitingMeetingTally(read, gate.standing, ledger).pending;
  };

  const judgeHere = async (vault: string, run: WaitingCounterRun, fresh: boolean) => {
    const failing = watch.stepFailing?.(vault) ?? null;
    if (failing === null) {
      warnedFailing.delete(vault);
      judgedHere.delete(vault);
      return say(vault, null);
    }
    const { problem } = failing;
    const on = `${problem}\n${postProcessingMark(ledgerOf(vault))}`;
    const before = last(vault);
    // News of other notes, with the failure and the ledger as they were: what was said stands, the gate unasked.
    if (!fresh && before?.kind === 'failing' && judgedHere.get(vault) === on) return before;
    judgedHere.set(vault, on);
    const mac = failing.mac?.trim() || 'this Mac';
    if (failingWarningDue({ problem, warned: warnedFailing.get(vault) ?? null })) {
      run.activity.record(postProcessingFailingReport({ mac, problem }));
      warnedFailing.set(vault, problem);
    }
    const counted = await pendingHere(vault, run);
    // While a pull is under way, a count already said stands.
    const count =
      counted === 'pulling' ? (before?.kind === 'failing' ? before.count : null) : counted;
    return say(vault, { kind: 'failing', mac, count, problem });
  };

  const uncounted = async (
    vault: string,
    run: WaitingCounterRun,
    waiting: Extract<MeetingsWaiting, { kind: 'uncounted' }>,
  ) => {
    // Nothing to say where no meeting file lands at all.
    const { files } = await knownFor(vault, run);
    return say(vault, files.size === 0 ? null : waiting);
  };

  return {
    heard: (vault, changes) => {
      const touches = touchesWaitingMeetings(changes);
      if (touches) generation += 1;
      if (touches && known?.vault === vault) forget(known.files, changes);
      return touches;
    },
    last,
    wrote: (vault, paths) => {
      if (paths.length > 0) generation += 1;
      if (known?.vault !== vault) return;
      for (const path of paths) known.files.set(path, null);
    },
    judgeHere: (vault, run, options) => judgeHere(vault, run, options?.fresh ?? true),
    judge: async (vault, run) => {
      const named = watch.namedElsewhere(vault);
      if (named === null) return say(vault, null);
      const gate = await watch.countGate(vault);
      if (gate.open) return count(vault, run, gate.standing);
      // Never a line in these, so nothing to list or read.
      if (gate.why === 'not-synced' || gate.why === 'settings-unreadable') return say(vault, null);
      if (gate.why === 'pulling') return last(vault);
      const mac = waitingMacLabel(named.name);
      return uncounted(vault, run, { kind: 'uncounted', mac, why: gate.why });
    },
  };
}

type CountedNow = { readonly count: number; readonly deferred: number; readonly mac: string };

const isRead = (file: WaitingMeetingFile | null): file is WaitingMeetingFile => file !== null;

/**
 * Whether a meeting could wait on a rule that writes summaries, whatever its
 * query takes: let in, with turns, dated, and no summary block. Only these
 * are asked of the index.
 */
const couldBePending = (file: WaitingMeetingFile): boolean =>
  file.read !== null &&
  !isConflictCopyPath(file.path) &&
  file.read.importOutcome === 'imported' &&
  file.read.postProcessing.summary === 'none' &&
  file.read.postProcessing.hasTurns &&
  file.read.postProcessing.date !== null;

/** Marks the meeting files news names to be read again, and forgets the ones removed. */
function forget(files: Known['files'], changes: readonly NoteChange[]): void {
  for (const change of changes) {
    if (!isMeetingInboxPath(change.path)) continue;
    if (change.kind === 'removed') files.delete(change.path);
    else files.set(change.path, null);
  }
}
