import {
  digestOf,
  claudeFiledNoteProblem,
  foldedVaultPath,
  lastUndoableRun,
  loggedActionProblem,
  madeTaskMeeting,
  splitFrontmatter,
  unarchiveProblem,
  type DoneAction,
  type LogEntry,
  type PassedOver,
  type VaultPath,
} from '@dfai/domain';
import { unarchiveNotes } from '../archive/archive-notes.ts';
import {
  MeetingSummaryRefused,
  undoMeetingSummary,
  type SummaryToTakeBack,
} from '../meetings/write-meeting-summary.ts';
import { homeFolderFor } from '../notes/home-folder.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import {
  changeProperties,
  UNSAVED_TYPING,
  type PropertyChange,
  type PropertyOutcome,
} from './apply-changes.ts';
import { appendForRun, reported } from './automation-activity.ts';
import { readRuleLog } from './automation-log.ts';
import { archiveRecord, type AutomationPorts, type AutomationRun } from './run-automation.ts';
import { guardedFs, stillInVault } from './vault-guard.ts';

const MOVED_SINCE = 'It is no longer where the run put it, so it was left where it is.';

type Run = Extract<LogEntry, { kind: 'run' }>;
type UndoPorts = AutomationPorts & { notePaths: readonly VaultPath[] };

/**
 * Undoes a rule's last run (P25-02), from what its log says it did: each note
 * it archived goes back where it was, and each property it set goes back to
 * what it held — unless it has changed since, which is left as it is and said
 * so. Settles with the undo's log entry, or null when there is no run to undo.
 *
 * The log is a note anyone could have written (A25-01), so a line is carried
 * out only when this rule's own action could have done it, to a value a
 * property could hold, and — for an archived note — only while the note's
 * archive stamp is the run's. Every other line is left, and named.
 *
 * What the undo did, or why it stopped, goes to the Activity log too.
 */
export async function undoLastRun(run: AutomationRun): Promise<LogEntry | null> {
  const { activity, rule } = run;
  return reported({ activity, rule, doing: 'undo', carryOut: () => undoOnce(run) });
}

async function undoOnce(run: AutomationRun): Promise<LogEntry | null> {
  const { rule, clock, guard } = run;
  stillInVault(guard);
  const fs = guardedFs(run.ports.fs, guard);
  const ports = { ...run.ports, fs, notePaths: await listVaultNotes({ fs }) };
  const last = lastUndoableRun((await readRuleLog(ports.fs, rule)).entries);
  if (last === null) return null;
  const at = clock.localNow();

  const refused: PassedOver[] = [];
  const logged = last.done.filter((line) => {
    const problem = loggedActionProblem(rule.action, line);
    if (problem !== null)
      refused.push({ path: 'path' in line ? line.path : line.to, reason: problem });
    return problem === null;
  });
  const trusted = rule.action.kind === 'claude' ? await onMeetings(ports, logged, refused) : logged;
  let archived: PropertyOutcome = { done: [], left: [] };
  let restored: PropertyOutcome = { done: [], left: [] };
  let summaries: SummariesTakenBack = { done: [], left: [], handled: new Set() };
  const entry = (): LogEntry => ({
    kind: 'undo',
    at,
    of: last.at,
    done: [...archived.done, ...restored.done, ...summaries.done],
    left: [...refused, ...archived.left, ...restored.left, ...summaries.left],
  });
  try {
    archived = await putBack({ ports, run: last, done: trusted });
    const sets = restoringChanges(trusted);
    summaries = await takeBackSummaries({ ports, run: last, done: trusted, sets });
    // What a meeting's own write took back is not restored again; the rest, and what it left, is.
    restored = await changeProperties({
      ports,
      changes: sets.filter((change) => !summaries.handled.has(change)),
      kind: 'restored',
      today: clock.today(),
    });
  } finally {
    // As a run does: what the undo changed is logged however it ends, in the rule's own vault.
    await appendForRun({ fs: run.ports.fs, run, entry: entry() });
  }
  stillInVault(guard);
  return entry();
}

/**
 * Takes the notes the run archived out of the Archive: those still where it
 * put them, stamped as archived by it.
 */
async function putBack({
  ports,
  run,
  done,
}: {
  ports: UndoPorts;
  run: Run;
  done: readonly DoneAction[];
}): Promise<PropertyOutcome> {
  const archived = done.flatMap((action) => (action.kind === 'archived' ? [action] : []));
  if (archived.length === 0) return { done: [], left: [] };
  const present = new Set(ports.notePaths.map(foldedVaultPath));
  const left: PassedOver[] = archived
    .filter(({ to }) => !present.has(foldedVaultPath(to)))
    .map(({ to }) => ({ path: to, reason: MOVED_SINCE }));
  const there = archived.filter(({ to }) => present.has(foldedVaultPath(to)));
  const stamps = await stampsOf(
    ports,
    there.map(({ to }) => to),
  );
  const ours: VaultPath[] = [];
  for (const { from, to } of there) {
    const problem = unarchiveProblem({ runAt: run.at, from, properties: stamps.get(to) ?? {} });
    if (problem === null) ours.push(to);
    else left.push({ path: to, reason: problem });
  }
  const outcome =
    ours.length === 0
      ? { moves: [], failed: [], linksUpdated: 0 }
      : await unarchiveNotes({
          ports,
          paths: ours,
          notePaths: ports.notePaths,
          updateLinks: true,
          unsavedTyping: 'leave',
        });
  const record = archiveRecord(outcome, 'unarchived');
  return { done: record.done, left: [...left, ...record.left] };
}

/**
 * Of a Claude step's lines, those whose note is a meeting now: the step files
 * only meetings, so a line naming another note — a log anyone can write says
 * it — is refused and named ({@link claudeFiledNoteProblem}). A note gone
 * since is left to the restore, which says so.
 */
async function onMeetings(
  ports: UndoPorts,
  lines: readonly DoneAction[],
  refused: PassedOver[],
): Promise<DoneAction[]> {
  const paths = lines.flatMap((line) => (line.kind === 'set' ? [line.path] : []));
  const notes = paths.length === 0 ? new Map() : await stampsOf(ports, paths);
  return lines.filter((line) => {
    const properties = line.kind === 'set' ? notes.get(line.path) : undefined;
    const problem = properties === undefined ? null : claudeFiledNoteProblem(properties);
    if (problem !== null && line.kind === 'set') refused.push({ path: line.path, reason: problem });
    return problem === null;
  });
}

/** Each note's frontmatter, as its archive stamp is read from. */
async function stampsOf(
  ports: UndoPorts,
  paths: readonly VaultPath[],
): Promise<Map<string, Readonly<Record<string, unknown>>>> {
  const files = await ports.fs.readNotes(paths);
  return new Map(
    files.map((file) => [
      file.path,
      ports.markdown.frontmatterProperties(splitFrontmatter(file.text).frontmatter),
    ]),
  );
}

/** Each property the run set, back to what it held — while it still holds what the run left. */
function restoringChanges(done: readonly DoneAction[]): PropertyChange[] {
  return done.flatMap((action): PropertyChange[] =>
    action.kind === 'set'
      ? [{ path: action.path, key: action.key, expect: action.after, to: action.before }]
      : [],
  );
}

/** What taking back the meetings' writes did, and which `project` lines it dealt with. */
interface SummariesTakenBack extends PropertyOutcome {
  readonly handled: ReadonlySet<PropertyChange>;
}

const CHANGED_SINCE = 'It was changed since the run made it, so it was kept.';
const NOT_THERE = 'It is no longer where the run made it, so it was left.';
const meetingKept = (reason: string) => `Its meeting was left as it is, so it was kept: ${reason}`;

/** A task the run made, unchanged since, and the meeting it is from. */
interface MadeTask {
  readonly path: VaultPath;
  readonly meeting: VaultPath;
}

/**
 * Takes back what the declared step wrote (#185), one meeting at a time: the
 * meeting is checked, its tasks go to the Trash, and then one write takes its
 * summary block out, or back to the one it replaced, with the links to the
 * tasks the Trash took. A task changed since stays, and so does its link, as
 * does one the Trash refused (#685). A meeting that refuses (its block edited
 * since, typed in) is left, and so is every task of it. One that changes
 * while its tasks are trashed is left, saying why, still linking them: they
 * are in the Trash to put back. No summary says a task was made that is gone.
 * A logged task undo cannot believe the run made (A25-01) is left, and named.
 */
async function takeBackSummaries({
  ports,
  run,
  done,
  sets,
}: {
  ports: UndoPorts;
  run: Run;
  done: readonly DoneAction[];
  /** The `project` lines to put back: a meeting's own are taken in its one write. */
  sets: readonly PropertyChange[];
}): Promise<SummariesTakenBack> {
  const summaries = new Map<VaultPath, SummaryToTakeBack>();
  for (const action of done) {
    if (action.kind === 'summarised') summaries.set(action.path, action);
  }
  const { made, left } = await madeTasks({ ports, run, done, meetings: [...summaries.keys()] });
  const meetings = [...new Set([...summaries.keys(), ...made.map(({ meeting }) => meeting)])];
  const did: DoneAction[] = [];
  const handled = new Set<PropertyChange>();
  for (const meeting of meetings) {
    const trashing = made.filter((task) => task.meeting === meeting).map(({ path }) => path);
    const summary = summaries.get(meeting) ?? null;
    const project = sets.find((change) => change.path === meeting) ?? null;
    const asked = new Set<VaultPath>();
    const trash = async (tasks: readonly VaultPath[]) => {
      const trashed = await trashTasks(ports.fs, tasks, left);
      tasks.forEach((path) => asked.add(path));
      did.push(...trashed.map((path) => ({ kind: 'trashed' as const, path })));
      return trashed;
    };
    try {
      const undone = await undoMeetingSummary(ports, {
        meeting,
        summary,
        trashing,
        trash,
        notePaths: ports.notePaths,
        project,
      });
      if (project !== null) handled.add(project);
      if (undone.restored !== null) did.push(undone.restored);
      if (undone.projectLeft !== null) left.push({ path: meeting, reason: undone.projectLeft });
    } catch (cause) {
      if (!(cause instanceof MeetingSummaryRefused)) throw cause;
      if (summary !== null) left.push({ path: meeting, reason: cause.message });
      // Refused after its tasks were trashed, those are logged as trashed; the rest are kept.
      const kept = trashing.filter((path) => !asked.has(path));
      left.push(...kept.map((path) => ({ path, reason: meetingKept(cause.message) })));
      continue;
    }
    if (summary !== null) did.push({ kind: 'unsummarised', path: meeting });
  }
  return { done: did, left, handled };
}

/**
 * Trashes each task, and answers with those the Trash took. One the host
 * refuses — any host refusal: reached through a link (#685), a Trash that
 * says no — is left and named instead. Any other error stops the undo.
 */
async function trashTasks(
  fs: UndoPorts['fs'],
  tasks: readonly VaultPath[],
  left: PassedOver[],
): Promise<VaultPath[]> {
  const trashed: VaultPath[] = [];
  for (const path of tasks) {
    try {
      await fs.trashEntry({ path });
      trashed.push(path);
    } catch (cause) {
      if (!(cause instanceof VaultAccessError)) throw cause;
      left.push({ path, reason: cause.message });
    }
  }
  return trashed;
}

/**
 * The tasks the run's log says it made that undo may trash: each still as
 * made, and one the run could have made — a task from a meeting it read, in
 * the folder it made tasks in. The rest are left, with why.
 */
async function madeTasks({
  ports,
  run,
  done,
  meetings,
}: {
  ports: UndoPorts;
  run: Run;
  done: readonly DoneAction[];
  /** The meetings the run wrote a summary to: read by it, whatever its tallies say. */
  meetings: readonly VaultPath[];
}): Promise<{ made: MadeTask[]; left: PassedOver[] }> {
  const runMeetings = [...meetings, ...(run.claude?.meetings ?? []).map(({ path }) => path)];
  const made: MadeTask[] = [];
  const left: PassedOver[] = [];
  for (const action of done) {
    if (action.kind !== 'created' || action.digest === undefined) continue;
    const { path, digest } = action;
    const read = await readUnchangedTask(ports, path, digest);
    if (!read.ok) {
      left.push({ path, reason: read.reason });
      continue;
    }
    const properties = ports.markdown.frontmatterProperties(
      splitFrontmatter(read.text).frontmatter,
    );
    const home = await homeFolderFor({
      fs: ports.fs,
      markdown: ports.markdown,
      properties,
      today: run.at.slice(0, 10),
    });
    const ours = madeTaskMeeting({
      path,
      properties,
      runMeetings,
      notePaths: ports.notePaths,
      home,
    });
    if (ours.ok) made.push({ path, meeting: ours.meeting });
    else left.push({ path, reason: ours.reason });
  }
  return { made, left };
}

/** A task the run made, as it is now — or why it is not to be trashed: typed in, changed since, or gone. */
async function readUnchangedTask(
  ports: UndoPorts,
  path: VaultPath,
  digest: string,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (ports.editors.state(path) === 'dirty') return { ok: false, reason: UNSAVED_TYPING };
  const [file] = await ports.fs.readNotes([path]);
  if (file === undefined) return { ok: false, reason: NOT_THERE };
  return digestOf(file.text) === digest
    ? { ok: true, text: file.text }
    : { ok: false, reason: CHANGED_SINCE };
}
