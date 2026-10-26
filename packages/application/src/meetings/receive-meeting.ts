import {
  createVaultPath,
  importErrorText,
  joinVaultPath,
  mapMeeting,
  MeetingMappingError,
  parentVaultPath,
  vaultPathName,
  type MappingOptions,
  type MeetingFields,
  type MeetingFile,
  type MeetingIdentity,
  type VaultPath,
} from '@dfai/domain';
import { ensureFolder } from '../vault/create-folder.ts';
import { meetingCalendarStart } from './meeting-calendar-start.ts';
import { holdingAt, meetingHoldersIn, type HolderPorts } from './meeting-files.ts';
import { validateMeetingFile } from './meeting-reading.ts';

/** What became of a meeting sent from outside: written into its month's folder, or already in the vault. */
export interface MeetingReceipt {
  /** The new file's path, or the note that already holds the meeting. */
  readonly path: VaultPath;
  readonly outcome: 'written' | 'in-vault';
}

/** Both of a meeting's paths hold other meetings; it is never written under a third name. */
export class MeetingPathsTakenError extends Error {
  override readonly name = 'MeetingPathsTakenError';
}

/**
 * Takes in a meeting another program sends (#93): mapped by the rules n8n's
 * workflow maps by, checked against meeting/v1, and written into its month's
 * folder, `Meetings/2026/10/` (#214), where the import settles it as it
 * settles any arrival (P28-04) — this writes no stamp of its own.
 *
 * A meeting the vault already holds, by the import's own rule, is not
 * written again. The index lags what was written a moment ago, so a file
 * already at either of the meeting's paths is read too: the same meeting
 * there is held; another meeting there passes it to the next path. Nothing
 * is written over, and the folders are made when missing. A meeting that
 * carries no start takes its calendar event's (#582), read from the day's
 * event notes.
 *
 * Throws a `MeetingMappingError` when the meeting cannot be mapped, or maps
 * to a file the contract refuses, and a {@link MeetingPathsTakenError} when
 * both its paths hold other meetings.
 */
export async function receiveMeeting({
  ports,
  fields,
  options,
}: {
  ports: HolderPorts;
  fields: MeetingFields;
  options: MappingOptions;
}): Promise<MeetingReceipt> {
  const calendar = await meetingCalendarStart({ index: ports.index, fields, options });
  const file = checkedMeeting(ports, mapMeeting(fields, { ...options, calendar }));
  const held = await heldInVault(ports, file);
  if (held !== null) return { path: held, outcome: 'in-vault' };
  const month = parentVaultPath(createVaultPath(file.path));
  const folder = await ensureFolder({ fs: ports.fs, folder: month });
  for (const path of [file.path, file.collisionPath]) {
    const placed = joinVaultPath(folder, vaultPathName(createVaultPath(path)));
    const receipt = await writeUnlessTaken(ports, { path: placed, file });
    if (receipt !== null) return receipt;
  }
  throw new MeetingPathsTakenError(
    `Other meetings hold both paths of ${file.provider} ${file.externalId}; not writing it`,
  );
}

/** The mapped file, refused as the import would refuse it when it breaks the contract. */
function checkedMeeting(ports: HolderPorts, file: MeetingFile): MeetingFile {
  const verdict = validateMeetingFile(ports.markdown, file.content);
  if (verdict.ok) return file;
  throw new MeetingMappingError(
    `The meeting maps to a file meeting/v1 refuses: ${importErrorText(verdict.errors)}`,
  );
}

/** A note that holds the meeting now, as the import counts holders: one it let in first. */
async function heldInVault(
  ports: HolderPorts,
  meeting: MeetingIdentity,
): Promise<VaultPath | null> {
  const { imported, unsettled } = await meetingHoldersIn(ports, { meeting, skip: () => false });
  const holder = imported[0] ?? unsettled[0];
  return holder === undefined ? null : createVaultPath(holder);
}

/**
 * Writes the file at `path` unless something is there: then it is held when
 * that is this meeting, and null — try the next path — when it is not. A
 * failure with nothing there is the write's own, and is passed on.
 */
async function writeUnlessTaken(
  ports: HolderPorts,
  { path, file }: { path: VaultPath; file: MeetingFile },
): Promise<MeetingReceipt | null> {
  try {
    await ports.fs.createNote({ path, contents: file.content });
    return { path, outcome: 'written' };
  } catch (error) {
    if (!(await somethingAt(ports, path))) throw error;
    const held = await holdingAt(ports, { holder: path, meeting: file });
    return held === null ? null : { path, outcome: 'in-vault' };
  }
}

async function somethingAt({ fs }: HolderPorts, path: VaultPath): Promise<boolean> {
  try {
    await fs.readTextFile(path);
    return true;
  } catch {
    // Unreadable is taken as nothing there: the create's own failure is then the one passed on.
    return false;
  }
}
