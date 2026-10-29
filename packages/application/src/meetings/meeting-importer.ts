import {
  meetingImportStoppedReport,
  messageWithoutPaths,
  type NoteChange,
  type VaultPath,
  type Vocabulary,
} from '@dfai/domain';
import type { ActivityLog } from '../activity/ports.ts';
import type { NoteChangeNews, NoteChanges } from '../index/note-changes.ts';
import type { Clock } from '../ports.ts';
import {
  catchUpMeetings,
  createUnsettledSaid,
  importArrivedMeetings,
  type MeetingImportOutcome,
  type MeetingImportPorts,
  type MeetingImportRun,
} from './import-arrived-meetings.ts';
import { createWaitingCounter, type MeetingsWaitingWatch } from './meetings-waiting.ts';

/**
 * Imports meetings (P28-04): as the change feed hears of them, and all at
 * once when asked to catch up. Runs go one at a time, so two never settle the
 * same meeting at once.
 *
 * Only the Mac that runs the vault's automations imports, and only on fresh
 * sync state (ADR-0035 part 4) — `active` says whether it may, as each run's
 * turn comes, and `mayWrite` again for each file, right before each write —
 * so two Macs never write the same file. A run or a file it may not make
 * writes nothing; nothing is lost by that, since what a file is due is in
 * the file, and catching up when the import starts, when this Mac takes the
 * automations over, or when a pull completes settles every file left. On a
 * Mac that is not named, a run it may not make is not silent (ADR-0035
 * parts 1 and 3): it counts what waits for the named Mac, as `waiting` is
 * told, and warns in Activity once per pull while meetings wait.
 *
 * A file it leaves unsettled — a conflict copy, one it cannot read or write —
 * is said in Activity once while the window is open, and again only when it
 * changes: the catch-up after every pull meets it each time.
 *
 * The ports answer for whichever vault is open, so a run for a vault that is
 * no longer open is dropped too. They are asked for at the start of each
 * run, so the window can hand over new ones — as it does whenever the tree
 * is re-read — without the queue being lost.
 */
export interface MeetingImporter {
  /**
   * Settles once these changes are imported; on a Mac that is not named,
   * once what waits is counted, with nothing imported and `waiting` set.
   * Null when dropped, or when the run failed (said in Activity).
   */
  hear(news: NoteChangeNews): Promise<MeetingImportOutcome | null>;
  /** Settles once every unsettled file in the vault's meeting folder is, or what waits is counted; null when dropped. */
  catchUp(vault: string): Promise<MeetingImportOutcome | null>;
  /**
   * Says again what waits, importing nothing (#182): for when what the rules
   * have finished with, or whether this Mac's step reaches Claude, changed.
   */
  recount(vault: string): Promise<MeetingImportOutcome | null>;
}

export function createMeetingImporter({
  ports,
  clock,
  activity,
  openVault,
  active,
  mayWrite,
  onWritten,
  beforeLetIn,
  waiting,
}: {
  /** The ports as they are now, asked for at the start of each run. */
  ports: () => MeetingImportPorts;
  clock: Pick<Clock, 'today'>;
  activity: ActivityLog;
  /** The vault open now, which the ports answer for; null when none is. */
  openVault: () => string | null;
  /**
   * Whether this Mac may import into the vault now: it runs the vault's
   * automations, on fresh sync state (ADR-0035 part 4). Asked as each run's
   * turn comes, right before it acts.
   */
  active: (vault: string) => boolean | Promise<boolean>;
  /**
   * Whether this Mac may write into one file of the vault now (ADR-0035
   * part 4): asked as each file is read and right before each of its writes,
   * with when it was last modified as the run first read it. Left out, it may.
   */
  mayWrite?: (vault: string, path: VaultPath, arrivedAt: number) => Promise<boolean>;
  /** Told when the import wrote or moved a note, so the tree and the index read it again. */
  onWritten: () => void;
  /**
   * Done to each meeting about to be let in, before it is stamped (see
   * `MeetingImportRun.beforeLetIn`); settles when done, and never rejects.
   * If the vault is no longer the one open once it settles, the meeting is
   * not stamped.
   */
  beforeLetIn?: (
    vault: string,
    path: VaultPath,
    reading: { readonly vocabulary: Vocabulary },
  ) => Promise<void>;
  /** Left out, a run this Mac may not make is dropped without a word, as before ADR-0035. */
  waiting?: MeetingsWaitingWatch;
}): MeetingImporter {
  let queue: Promise<unknown> = Promise.resolve();
  const unsettledSaid = createUnsettledSaid();
  const countWaiting = waiting === undefined ? null : createWaitingCounter(waiting);

  /**
   * What a run this Mac may not make says instead of nothing: what waits, on
   * a Mac that is not named. News that names no meeting file cannot change
   * that, and asks nothing — no gate, no read.
   */
  const notImporting = async (
    vault: string,
    news: readonly NoteChange[] | null,
  ): Promise<MeetingImportOutcome | null> => {
    if (countWaiting === null) return null;
    const said =
      news !== null && !countWaiting.heard(vault, news)
        ? countWaiting.last(vault)
        : await countWaiting.judge(vault, { ports: ports(), activity: activity.inVault(vault) });
    return said === null ? null : { happenings: [], wrote: false, waiting: said };
  };

  /**
   * What the Mac that imports says once a run is done (#182): that its step
   * cannot reach Claude, while that holds. The files the run wrote or moved
   * are read again when next judged, and news that named others has them read again.
   */
  const afterImport = async (
    vault: string,
    news: readonly NoteChange[] | null,
    outcome: MeetingImportOutcome | null,
  ): Promise<MeetingImportOutcome | null> => {
    if (countWaiting === null) return outcome;
    if (news !== null) countWaiting.heard(vault, news);
    countWaiting.wrote(vault, outcome?.happenings.map(({ path }) => path) ?? []);
    const said = await countWaiting.judgeHere(vault, {
      ports: ports(),
      activity: activity.inVault(vault),
    });
    if (outcome === null)
      return said === null ? null : { happenings: [], wrote: false, waiting: said };
    return said === null ? outcome : { ...outcome, waiting: said };
  };

  const runFor = (
    vault: string,
    importing: ((run: MeetingImportRun) => Promise<MeetingImportOutcome>) | null,
    news: readonly NoteChange[] | null,
  ): Promise<MeetingImportOutcome | null> => {
    const next = queue.then(async () => {
      if (openVault() !== vault) return null;
      const mayImport = await active(vault);
      // Another vault may have opened while the gate was read.
      if (openVault() !== vault) return null;
      const recorder = activity.inVault(vault);
      try {
        if (!mayImport) return await notImporting(vault, news);
        if (importing === null) return await afterImport(vault, null, null);
        const outcome = await importing({
          ports: ports(),
          today: clock.today(),
          activity: recorder,
          unsettledSaid,
          ...(mayWrite !== undefined && {
            mayWrite: (path, arrivedAt) => mayWrite(vault, path, arrivedAt),
          }),
          ...(beforeLetIn !== undefined && {
            beforeLetIn: async (path, reading) => {
              await beforeLetIn(vault, path, reading);
              // The hook does nothing once another vault is open; nor may the stamp that follows it.
              return openVault() === vault ? undefined : 'vault-changed';
            },
          }),
        });
        if (outcome.wrote) onWritten();
        return await afterImport(vault, news, outcome);
      } catch (cause) {
        // Not one file, which the run says itself: the run could not start, or the folder be read.
        recorder.record(meetingImportStoppedReport(messageWithoutPaths(cause)));
        return null;
      }
    });
    queue = next;
    return next;
  };

  return {
    hear: (news) =>
      runFor(
        news.vault,
        (run) => importArrivedMeetings({ ...run, changes: news.changes }),
        news.changes,
      ),
    catchUp: (vault) => runFor(vault, catchUpMeetings, null),
    recount: (vault) => runFor(vault, null, null),
  };
}

/** Hands every sync's news to the importer; returns the way to stop. */
export function importMeetingsOnArrival({
  changes,
  importer,
}: {
  changes: NoteChanges;
  importer: MeetingImporter;
}): () => void {
  return changes.subscribe((news) => {
    // A run never rejects: what goes wrong is said in Activity by the importer.
    void importer.hear(news);
  });
}
