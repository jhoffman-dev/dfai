import {
  answeredMeetingOf,
  compileProjectOptionsQuery,
  MEETING_PROJECT_KEY,
  messageWithoutPaths,
  noteTitle,
  projectChoiceOutcome,
  projectOptionsOf,
  rankProjects,
  splitFrontmatter,
  type AnsweredNote,
  type DoneAction,
  type MeetingProjectTies,
  type NewProposal,
  type ProjectChoice,
  type ProjectOption,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { changeProperties, type PropertyChange } from './apply-changes.ts';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import { loadMeetingEntities, loadProjectTies } from '../meeting-links/link-directory.ts';

/** The open projects and areas a meeting may be filed under, read from the index (#227). */
export async function loadProjectOptions({
  index,
}: {
  index: Pick<IndexPort, 'query'>;
}): Promise<ProjectOption[]> {
  const { sql, parameters } = compileProjectOptionsQuery();
  const result = await index.query(sql, parameters);
  const cell = (row: readonly unknown[], name: string) => row[result.columns.indexOf(name)];
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return projectOptionsOf(
    result.rows.map((row) => ({
      path: String(cell(row, 'path')),
      title: String(cell(row, 'title') ?? ''),
      type: text(cell(row, 'type')),
      para: text(cell(row, 'para')),
      status: text(cell(row, 'status')),
    })),
  );
}

/**
 * Each unfiled meeting's open projects tied to its people and companies,
 * likeliest first, as linking ranks them (#793): what its list of projects
 * shows before the rest, so the cut never takes the one linking proposes.
 */
export async function loadMeetingProjectTies({
  index,
  notes,
}: {
  index: Pick<IndexPort, 'query'>;
  notes: readonly AnsweredNote[];
}): Promise<MeetingProjectTies> {
  const ties = new Map<string, VaultPath[]>();
  for (const note of notes) {
    if (note.meeting === undefined || note.meeting.filed === true) continue;
    const entities = await loadMeetingEntities({ index, meeting: note.path });
    const tied = await loadProjectTies({ index, meeting: note.path, entities });
    ties.set(
      note.path,
      rankProjects(tied).map(({ project }) => project),
    );
  }
  return ties;
}

/** What the run does with the projects Claude chose: meetings to file, and proposals to write. */
export interface PlannedFilings {
  /** Each meeting's `project` to set, only while it still holds what was read. */
  readonly changes: readonly PropertyChange[];
  readonly proposals: readonly { readonly meeting: VaultPath; readonly proposal: NewProposal }[];
}

/**
 * What becomes of each meeting's choice (`projectChoiceOutcome`), from the
 * meeting as it is now — never from the model — so one filed since it was
 * asked about is left as it is.
 */
export async function planProjectChoices({
  ports,
  choices,
  notePaths,
  madeBy,
}: {
  ports: {
    fs: Pick<VaultFsPort, 'readNotes'>;
    markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
  };
  choices: readonly { readonly meeting: VaultPath; readonly choice: ProjectChoice | null }[];
  notePaths: readonly VaultPath[];
  madeBy: string;
}): Promise<PlannedFilings> {
  const chosen = choices.flatMap(({ meeting, choice }) =>
    choice === null ? [] : [{ meeting, choice }],
  );
  if (chosen.length === 0) return { changes: [], proposals: [] };
  const files = await ports.fs.readNotes(chosen.map(({ meeting }) => meeting));
  const read = new Map(
    files.map((file) => [
      file.path,
      ports.markdown.frontmatterProperties(splitFrontmatter(file.text).frontmatter),
    ]),
  );
  const changes: PropertyChange[] = [];
  const proposals: { meeting: VaultPath; proposal: NewProposal }[] = [];
  for (const { meeting, choice } of chosen) {
    const properties = read.get(meeting);
    if (properties === undefined) continue;
    const identity = answeredMeetingOf(properties)?.identity ?? null;
    const project = properties[MEETING_PROJECT_KEY];
    const outcome = projectChoiceOutcome({
      meeting: { path: meeting, identity, project },
      choice,
      notePaths,
      madeBy,
    });
    if (outcome.kind === 'propose') proposals.push({ meeting, proposal: outcome.proposal });
    if (outcome.kind === 'file') {
      const expect = Object.hasOwn(properties, MEETING_PROJECT_KEY)
        ? { value: project }
        : { absent: true as const };
      changes.push({
        path: meeting,
        key: MEETING_PROJECT_KEY,
        expect,
        to: { value: outcome.link },
      });
    }
  }
  return { changes, proposals };
}

/**
 * Files the meetings Claude was sure of: each `project` set, as a run's line
 * that "Undo last run" can put back. A meeting typed in, or changed since it
 * was read, is left, and said in `warnings`.
 */
export async function fileChosenMeetings({
  ports,
  changes,
  today,
  warnings,
}: {
  ports: Pick<ArchivePorts, 'fs' | 'markdown' | 'editors'>;
  changes: readonly PropertyChange[];
  today: string;
  warnings: string[];
}): Promise<readonly DoneAction[]> {
  if (changes.length === 0) return [];
  const { done, left } = await changeProperties({ ports, changes, kind: 'set', today });
  for (const { path, reason } of left) warnings.push(projectLeftWords(path, reason));
  return done;
}

/** What is said of a meeting left without the project Claude chose for it. */
export function projectLeftWords(meeting: VaultPath, reason: string): string {
  return `Left ${noteTitle(meeting)} without the project Claude chose: ${messageWithoutPaths(reason)}`;
}
