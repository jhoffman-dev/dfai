import { fileNameOf, folderOf, foldedPath, joinPath, type VaultPath } from '../vault/index.ts';

/** A calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/** `date` as `YYYY-MM-DD` in the device's own time zone: the day the person sees. */
export function isoDate(date: Date): IsoDate {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Where this device's version of a note both sides changed is kept:
 * `<name> (conflict <date>).md` beside it, numbered ` 2`, ` 3`… when that
 * name is taken (case aside). The remote version stays at the path.
 */
export function conflictCopyPath({
  path,
  date,
  taken,
}: {
  path: VaultPath;
  date: IsoDate;
  /** Every path in the vault, and every copy already planned, so none is overwritten. */
  taken: Iterable<VaultPath>;
}): VaultPath {
  const file = fileNameOf(path);
  const dot = file.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  const used = new Set<string>();
  for (const other of taken) used.add(foldedPath(other));
  for (let number = 1; ; number += 1) {
    const suffix = ` (conflict ${date})${number === 1 ? '' : ` ${number}`}`;
    const candidate = joinPath(folderOf(path), `${stem}${suffix}${extension}`);
    if (!used.has(foldedPath(candidate))) return candidate;
  }
}

const CONFLICT_COPY = / \(conflict \d{4}-\d{2}-\d{2}\)(?: \d+)?(?:\.[^./]*)?$/;

/** Whether a path is a conflict copy the app made: left for its owner to merge. */
export function isConflictCopyPath(path: VaultPath): boolean {
  return CONFLICT_COPY.test(path);
}
