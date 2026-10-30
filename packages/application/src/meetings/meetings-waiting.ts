import {
  createVaultPath,
  isMeetingInboxPath,
  meetingsWaitingReport,
  touchesWaitingMeetings,
  waitingMacLabel,
  waitingMeetingTally,
  waitingWarningDue,
  type CountableStanding,
  type MeetingsWaiting,
  type NoteChange,
  type WaitingCountGate,
  type WaitingMeetingFile,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
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
  /** Says nothing waits, and forgets what the files held: this Mac imports now, and writes them. */
  clear(vault: string): void;
  /** Judges what waits now, says it, and warns when the count is news. */
  judge(vault: string, run: WaitingCounterRun): Promise<MeetingsWaiting | null>;
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
    // The pull moved, the gates shut, or another Mac is no longer the one named, while the files were read.
    const after = await watch.countGate(vault);
    if (!after.open || after.standing !== standing) return last(vault);
    const named = watch.namedElsewhere(vault);
    if (named === null) return say(vault, null);
    const mac = waitingMacLabel(named.name);
    const tally = waitingMeetingTally([...files.values()].filter(isRead), standing);
    warnIfNews(vault, run, { ...tally, mac });
    return say(vault, { kind: 'counted', mac, count: tally.count });
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
      if (touches && known?.vault === vault) forget(known.files, changes);
      return touches;
    },
    last,
    clear: (vault) => {
      known = null;
      say(vault, null);
    },
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

/** Marks the meeting files news names to be read again, and forgets the ones removed. */
function forget(files: Known['files'], changes: readonly NoteChange[]): void {
  for (const change of changes) {
    if (!isMeetingInboxPath(change.path)) continue;
    if (change.kind === 'removed') files.delete(change.path);
    else files.set(change.path, null);
  }
}
