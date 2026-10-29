import {
  declaresImport,
  importOutcomeOf,
  meetingsWaitingReport,
  splitFrontmatter,
  waitingMacLabel,
  waitingMeetingCount,
  type CountableStanding,
  type MeetingsWaiting,
  type VaultPath,
  type WaitingCountGate,
  type WaitingMeetingFile,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { meetingInboxNotes } from './meeting-inbox.ts';
import { readFrontmatter } from './meeting-reading.ts';

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
  /** Told what waits each time it is judged: null when nothing is to be said, as on the named Mac. */
  readonly said: (vault: string, waiting: MeetingsWaiting | null) => void;
}

/** What the files where meetings land hold, as the import reads them: the same listing and the same reads. */
export async function readWaitingMeetings(ports: {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
}): Promise<WaitingMeetingFile[]> {
  const paths = await meetingInboxNotes(ports.fs);
  return Promise.all(paths.map((path) => readWaitingMeeting(ports, path)));
}

async function readWaitingMeeting(
  ports: Parameters<typeof readWaitingMeetings>[0],
  path: VaultPath,
): Promise<WaitingMeetingFile> {
  let read: Awaited<ReturnType<VaultFsPort['readTextFile']>>;
  try {
    read = await ports.fs.readTextFile(path);
  } catch {
    // A file that cannot be read is not the import's to settle, so it never counts: the rule says so.
    return { path, read: null };
  }
  const reading = readFrontmatter(ports.markdown, splitFrontmatter(read.text).frontmatter);
  // Frontmatter that does not read cannot be stamped either.
  if (reading.problem !== null) return { path, read: null };
  return {
    path,
    read: {
      importDeclared: declaresImport(reading.properties),
      importOutcome: importOutcomeOf(reading.properties),
      modifiedAt: read.modified,
    },
  };
}

/** What a counter is handed for each vault judged: its ports, and where its warning is said. */
export interface WaitingCounterRun {
  readonly ports: Parameters<typeof readWaitingMeetings>[0];
  readonly activity: ActivityRecorder;
}

/**
 * Says what waits for the named Mac, on a Mac that is not named: the line
 * the Inbox shows, and Activity's warning once per pull while meetings wait.
 * The files are read once per pull: asked again for the same pull, as every
 * change the index hears asks, it answers what it counted then and says
 * nothing new.
 */
export function createWaitingCounter(
  watch: MeetingsWaitingWatch,
): (vault: string, run: WaitingCounterRun) => Promise<MeetingsWaiting | null> {
  let last: { vault: string; standing: CountableStanding; waiting: MeetingsWaiting } | null = null;
  return async (vault, { ports, activity }) => {
    const named = watch.namedElsewhere(vault);
    if (named === null) {
      watch.said(vault, null);
      return null;
    }
    const mac = waitingMacLabel(named.name);
    const gate = await watch.countGate(vault);
    if (!gate.open) {
      const waiting: MeetingsWaiting = { kind: 'uncounted', mac, why: gate.why };
      watch.said(vault, waiting);
      return waiting;
    }
    const known = last?.vault === vault && last.standing === gate.standing ? last.waiting : null;
    const waiting: MeetingsWaiting =
      known?.kind === 'counted' && known.mac === mac
        ? known
        : await countAndSay({ ports, activity, standing: gate.standing, mac });
    last = { vault, standing: gate.standing, waiting };
    watch.said(vault, waiting);
    return waiting;
  };
}

async function countAndSay({
  ports,
  activity,
  standing,
  mac,
}: WaitingCounterRun & {
  standing: CountableStanding;
  mac: string;
}): Promise<MeetingsWaiting> {
  const count = waitingMeetingCount(await readWaitingMeetings(ports), standing);
  const report = meetingsWaitingReport({ count, mac });
  if (report !== null) activity.record(report);
  return { kind: 'counted', mac, count };
}
