import {
  currentPeriod,
  outputPeriod,
  periodNoteMade,
  periodNoteOf,
  periodRecorded,
  splitFrontmatter,
  writesOneNoteAPeriod,
  type AutomationRule,
  type ClaudeRunInfo,
  type LocalTime,
  type LogEntry,
  type OutputPeriod,
  type PeriodNote,
  type RunTrigger,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/** The period a run of a rule that writes one note a period writes for, and whether it is made. */
export interface PeriodState {
  readonly period: OutputPeriod;
  readonly made: boolean;
}

/**
 * The period's note arrived while the step was asking Claude — synced in from
 * the other Mac, which ran the rule too: nothing is written, and the run is
 * logged as one that found the note made. `claude` is what the ask cost.
 */
export class PeriodNoteArrived extends Error {
  constructor(readonly claude?: ClaudeRunInfo) {
    super('The note for this period arrived while Claude was asked: nothing was written.');
    this.name = 'PeriodNoteArrived';
  }
}

/** How many notes of the rule's folder are read at once, looking for the periods they say. */
const READ_BATCH = 100;

/**
 * Where a rule that writes one note a period stands for the run now: the
 * period it writes for — the one its schedule fell due at, or, by hand, the
 * calendar week or day it is now — and whether that period is made. Null for
 * any other rule.
 *
 * A scheduled run never writes a period that is recorded: its log says a run
 * made a note for it, or a note carries it, though that run was undone or the
 * note deleted since. A run by hand writes it afresh when its note is no longer
 * there. The log settles it when it can; the folder's notes are read only when
 * it does not, since a crash between the note and its log line leaves the
 * note alone to say so.
 */
export async function periodStateOf({
  rule,
  entries,
  at,
  trigger,
  fs,
  markdown,
  notePaths,
}: {
  /** Its `id` is left off for a rule not saved yet: then no note names it. */
  rule: Pick<AutomationRule, 'when' | 'action'> & { readonly id?: string };
  /** The rule's log, oldest first. */
  entries: readonly LogEntry[];
  /** The wall clock now. */
  at: LocalTime;
  trigger: RunTrigger;
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
  notePaths: readonly string[];
}): Promise<PeriodState | null> {
  if (!writesOneNoteAPeriod(rule)) return null;
  const find = trigger === 'hand' ? currentPeriod : outputPeriod;
  const period = find({ schedule: rule.when, at });
  if (period === null) return null;
  const existing = new Set(notePaths);
  const isMade = (notes: readonly PeriodNote[]): boolean => {
    const asked = {
      entries,
      notes,
      ...(rule.id !== undefined && { rule: rule.id }),
      period,
      schedule: rule.when,
      now: at,
    };
    return trigger === 'hand'
      ? periodNoteMade({ ...asked, exists: (path) => existing.has(path) }) !== null
      : periodRecorded(asked);
  };
  if (isMade([])) return { period, made: true };
  const notes = await periodNotesIn({ rule, fs, markdown, notePaths });
  return { period, made: isMade(notes) };
}

/** The notes in the rule's folder that say the period they were made for, and the rule they name. */
function periodNotesIn({
  rule,
  ...reads
}: {
  rule: Pick<AutomationRule, 'action'>;
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
  notePaths: readonly string[];
}): Promise<PeriodNote[]> {
  const { action } = rule;
  if (action.kind !== 'claude' || action.output.kind !== 'note') return Promise.resolve([]);
  return periodNotesInFolder({ folder: action.output.folder, ...reads });
}

/**
 * The notes in `folder`, at any depth, that say the period they were made
 * for, and the rule they name: what tells a period's note made when the log
 * cannot (a crash between the note and its log line, a note synced in).
 */
export async function periodNotesInFolder({
  folder,
  fs,
  markdown,
  notePaths,
}: {
  folder: string;
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
  notePaths: readonly string[];
}): Promise<PeriodNote[]> {
  const within = `${folder.replace(/\/+$/, '')}/`;
  const inFolder = notePaths.filter((path) => path.startsWith(within));
  return periodNotesAt({ paths: inFolder, fs, markdown });
}

/** The notes at `paths` that say the period they were made for, and the rule they name. */
export async function periodNotesAt({
  paths,
  fs,
  markdown,
}: {
  paths: readonly string[];
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
}): Promise<PeriodNote[]> {
  const found: PeriodNote[] = [];
  for (let start = 0; start < paths.length; start += READ_BATCH) {
    for (const file of await fs.readNotes(paths.slice(start, start + READ_BATCH))) {
      const note = periodNoteOf(
        file.path as VaultPath,
        markdown.frontmatterProperties(splitFrontmatter(file.text).frontmatter),
      );
      if (note !== null) found.push(note);
    }
  }
  return found;
}
