import { INDEX_ROOT, byteLength, fileText, type IndexFile } from './text.ts';
import { NOTE_LINE_FORMAT } from './note-line.ts';

/** A folder index is split once it would pass either limit, so no file is too big to read in one go. */
export const MAX_NOTES_PER_FILE = 400;
export const MAX_BYTES_PER_FILE = 48_000;

/** The file for notes at the vault root, which no folder holds. */
export const ROOT_FILE_NAME = '_root';

/** A note's line, by its path. */
export interface NoteEntry {
  readonly path: string;
  readonly line: string;
}

/** A top-level folder (`''` for the vault root): how many notes, and the file to read. */
export interface FolderSummary {
  readonly folder: string;
  readonly count: number;
  readonly file: string;
}

interface FolderJob {
  /** The folder the entries are in, `''` for the root. */
  readonly folder: string;
  /** Entries under `folder`, sorted by path. */
  readonly entries: readonly NoteEntry[];
  /** The index file for them, `_index/folders/….md`. */
  readonly file: string;
  /** True when only the folder's own notes are here, so it is cut into parts, not sub-folders. */
  readonly flat: boolean;
}

/** `_index/folders/`: one file per top-level folder, split by sub-folder or into parts when large. */
export function folderFiles(entries: readonly NoteEntry[]): {
  files: IndexFile[];
  folders: FolderSummary[];
} {
  const files: IndexFile[] = [];
  const folders: FolderSummary[] = [];
  const { direct, nested } = groupByNextFolder('', entries);
  for (const [name, group] of nested) {
    const file = `${INDEX_ROOT}/folders/${name}.md`;
    files.push(...folderJob({ folder: name, entries: group, file, flat: false }));
    folders.push({ folder: name, count: group.length, file });
  }
  if (direct.length > 0) {
    const file = `${INDEX_ROOT}/folders/${ROOT_FILE_NAME}.md`;
    files.push(...folderJob({ folder: '', entries: direct, file, flat: true }));
    folders.push({ folder: '', count: direct.length, file });
  }
  return { files, folders };
}

function folderJob(job: FolderJob): IndexFile[] {
  const lines = job.entries.map(({ line }) => line);
  if (fits(lines)) return [listingFile(job, lines)];
  const stem = job.file.slice(0, -'.md'.length);
  const { direct, nested } = groupByNextFolder(job.folder, job.entries);
  if (job.flat || nested.size === 0) return partFiles(job, stem);
  const subJobs: FolderJob[] = [...nested].map(([name, group]) => ({
    folder: `${job.folder}/${name}`,
    entries: group,
    file: `${stem}/${name}.md`,
    flat: false,
  }));
  if (direct.length > 0) {
    const file = `${stem}/${ROOT_FILE_NAME}.md`;
    subJobs.push({ folder: job.folder, entries: direct, file, flat: true });
  }
  const split = splitFile(job, 'split by sub-folder', subJobs.map(describeJob));
  return [split, ...subJobs.flatMap(folderJob)];
}

/** A folder's notes cut into parts in path order, each within the limits. */
function partFiles(job: FolderJob, stem: string): IndexFile[] {
  const parts: NoteEntry[][] = [[]];
  let bytes = 0;
  for (const entry of job.entries) {
    const current = parts.at(-1) as NoteEntry[];
    const size = byteLength(entry.line) + 1;
    if (current.length > 0 && (current.length >= MAX_NOTES_PER_FILE || bytes + size > BUDGET)) {
      parts.push([entry]);
      bytes = size;
    } else {
      current.push(entry);
      bytes += size;
    }
  }
  const partJobs = parts.map((entries, at) => ({
    ...job,
    entries,
    file: `${stem}/part-${at + 1}.md`,
  }));
  const rows = partJobs.map(
    ({ file, entries }) =>
      `${file} | ${entries.length} | ${entries[0]?.path ?? ''} … ${entries.at(-1)?.path ?? ''}`,
  );
  const split = splitFile(job, 'split into parts by path', rows);
  return [
    split,
    ...partJobs.map((part) =>
      listingFile(
        part,
        part.entries.map(({ line }) => line),
      ),
    ),
  ];
}

function describeJob({ file, entries, folder, flat }: FolderJob): string {
  return `${file} | ${entries.length} | ${flat ? `${folderLabel(folder)} (its own notes)` : `${folder}/`}`;
}

function listingFile(job: FolderJob, lines: readonly string[]): IndexFile {
  const heading = `# ${folderLabel(job.folder)} — ${job.entries.length} notes`;
  return { path: job.file, text: fileText([heading, NOTE_LINE_FORMAT, ...lines]) };
}

function splitFile(job: FolderJob, how: string, rows: readonly string[]): IndexFile {
  const heading = `# ${folderLabel(job.folder)} — ${job.entries.length} notes, ${how}`;
  return {
    path: job.file,
    text: fileText([heading, 'Line: index file to read | notes | what it holds.', ...rows]),
  };
}

const folderLabel = (folder: string): string => (folder === '' ? 'Vault root' : `${folder}/`);

/** Room for note lines once a file's two header lines are written. */
const BUDGET = MAX_BYTES_PER_FILE - byteLength(NOTE_LINE_FORMAT) - 200;

function fits(lines: readonly string[]): boolean {
  if (lines.length > MAX_NOTES_PER_FILE) return false;
  return lines.reduce((total, line) => total + byteLength(line) + 1, 0) <= BUDGET;
}

/** The entries right in `folder`, and the rest grouped by the sub-folder they are under, in order. */
function groupByNextFolder(
  folder: string,
  entries: readonly NoteEntry[],
): { direct: NoteEntry[]; nested: Map<string, NoteEntry[]> } {
  const prefix = folder === '' ? '' : `${folder}/`;
  const direct: NoteEntry[] = [];
  const nested = new Map<string, NoteEntry[]>();
  for (const entry of entries) {
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      direct.push(entry);
      continue;
    }
    const name = rest.slice(0, slash);
    const group = nested.get(name);
    if (group === undefined) nested.set(name, [entry]);
    else group.push(entry);
  }
  return { direct, nested };
}
