import {
  meetingsWaitingReport,
  touchesWaitingMeetings,
  waitingMacLabel,
  waitingMeetingTally,
  type CountableStanding,
  type MeetingsWaiting,
  type NoteChange,
  type WaitingCountGate,
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
  /** News of notes; whether it may change the count, which is then read again when next judged. */
  heard(vault: string, changes: readonly NoteChange[]): boolean;
  /** What was last said for the vault; null when nothing was. */
  last(vault: string): MeetingsWaiting | null;
  /** Says nothing waits: this Mac imports now. */
  clear(vault: string): void;
  /** Judges what waits now, says it, and warns when the count is news. */
  judge(vault: string, run: WaitingCounterRun): Promise<MeetingsWaiting | null>;
}

/** The last count made, and the pull it was made against. */
interface Counted {
  readonly vault: string;
  readonly standing: CountableStanding;
  readonly count: number;
  /** Files left for the next pull to judge (changed here after this one). */
  readonly deferred: number;
}

/**
 * The files are read again only when the count may have changed: news named
 * a meeting file, the gates opened again after being shut, or a file was left
 * for the next pull and a pull has completed. A pull that brought nothing — a
 * look at GitHub, about once a minute — reuses the count. While a pull is
 * under way, what was said stands.
 */
export function createWaitingCounter(watch: MeetingsWaitingWatch): WaitingCounter {
  let counted: Counted | null = null;
  let stale = false;
  let said: { vault: string; waiting: MeetingsWaiting | null } | null = null;
  // The count last said for each vault this session: Activity hears only a change.
  const lastCount = new Map<string, number>();

  const say = (vault: string, waiting: MeetingsWaiting | null) => {
    said = { vault, waiting };
    watch.said(vault, waiting);
    return waiting;
  };
  const last = (vault: string) => (said?.vault === vault ? said.waiting : null);
  const recountDue = (vault: string, standing: CountableStanding) =>
    counted?.vault !== vault || stale || (counted.deferred > 0 && counted.standing !== standing);

  const uncounted = async (
    vault: string,
    { ports }: WaitingCounterRun,
    waiting: Extract<MeetingsWaiting, { kind: 'uncounted' }>,
  ) => {
    stale = true;
    // Nothing to say where no meeting file lands at all; listing is local and reads no file.
    const listed = await meetingInboxNotes(ports.fs);
    return say(vault, listed.length === 0 ? null : waiting);
  };

  const count = async (
    vault: string,
    run: WaitingCounterRun,
    { standing, mac }: { standing: CountableStanding; mac: string },
  ): Promise<MeetingsWaiting | null> => {
    const files = await readWaitingMeetings(run.ports, await meetingInboxNotes(run.ports.fs));
    const after = await watch.countGate(vault);
    // The pull moved, or the gates shut, while the files were read: this count is not said.
    if (!after.open || after.standing !== standing) return last(vault);
    const tally = waitingMeetingTally(files, standing);
    counted = { vault, standing, ...tally };
    stale = false;
    const report = meetingsWaitingReport({
      count: tally.count,
      mac,
      lastCount: lastCount.get(vault) ?? null,
    });
    if (report !== null) run.activity.record(report);
    lastCount.set(vault, tally.count);
    return say(vault, { kind: 'counted', mac, count: tally.count });
  };

  return {
    heard: (vault, changes) => {
      const touches = touchesWaitingMeetings(changes);
      if (touches && counted?.vault === vault) stale = true;
      return touches;
    },
    last,
    clear: (vault) => void say(vault, null),
    judge: async (vault, run) => {
      const named = watch.namedElsewhere(vault);
      if (named === null) return say(vault, null);
      const mac = waitingMacLabel(named.name);
      const gate = await watch.countGate(vault);
      if (!gate.open) {
        if (gate.why === 'pulling') return last(vault);
        return uncounted(vault, run, { kind: 'uncounted', mac, why: gate.why });
      }
      if (!recountDue(vault, gate.standing) && counted !== null) {
        return say(vault, { kind: 'counted', mac, count: counted.count });
      }
      return count(vault, run, { standing: gate.standing, mac });
    },
  };
}
