import {
  captureFile,
  capturePeople,
  compileCaptureHoldersQuery,
  createVaultPath,
  holdsCapture,
  joinVaultPath,
  parentVaultPath,
  splitFrontmatter,
  type Capture,
  type CaptureFile,
  vaultPathName,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { loadLinkDirectory } from '../meeting-links/link-directory.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { listVaultNotes } from '../vault/read-vault.ts';

/** What a capture needs of the vault: its files, how frontmatter reads, and the index. */
export interface CapturePorts {
  readonly fs: VaultFsPort;
  readonly markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
  readonly index: Pick<IndexPort, 'query'>;
}

/** What became of a capture: written into the Inbox, or already in the vault. */
export interface CaptureReceipt {
  /** The new note's path, or the note that already holds the message. */
  readonly path: VaultPath;
  readonly outcome: 'written' | 'in-vault';
}

/** Both of a capture's paths hold other notes; it is never written under a third name. */
export class CapturePathsTakenError extends Error {
  override readonly name = 'CapturePathsTakenError';
}

/**
 * Saves a message another program read — n8n from Slack (#104), a pasted
 * link (#105), Claude (#106) — as an Inbox note or task (ADR-0049), its
 * authors linked to their Person notes when an address matches.
 *
 * A message the vault already holds, wherever it has been filed since, is
 * not written again: the index is asked, and since it lags a write made a
 * moment ago, so is the file at each of the capture's paths. Nothing is
 * written over; the folder is made when missing, and used as the vault
 * spells it.
 *
 * Throws a {@link CapturePathsTakenError} when both its paths hold other notes.
 */
export async function receiveCapture({
  ports,
  capture,
  timeZone,
}: {
  ports: CapturePorts;
  capture: Capture;
  /** The zone the note shows times on. */
  timeZone: string;
}): Promise<CaptureReceipt> {
  const held = await heldInVault(ports, capture);
  if (held !== null) return { path: held, outcome: 'in-vault' };
  const notePaths = await listVaultNotes({ fs: ports.fs });
  const { people } = await loadLinkDirectory({ index: ports.index });
  const personFor = capturePeople({ capture, people, notePaths });
  const file = captureFile(capture, { timeZone, personFor });
  const folder = await ensureFolder({
    fs: ports.fs,
    folder: parentVaultPath(createVaultPath(file.path)),
  });
  for (const each of [file.path, file.collisionPath]) {
    // In the folder as the vault spells it: `inbox/Captures`, on a disk that does not tell them apart.
    const path = joinVaultPath(folder, vaultPathName(createVaultPath(each)));
    const receipt = await writeUnlessTaken(ports, { path, file });
    if (receipt !== null) return receipt;
  }
  throw new CapturePathsTakenError(
    `Other notes hold both paths of ${capture.provider} ${capture.externalId}; not writing it`,
  );
}

/** The first note the index says holds this message, or null. */
async function heldInVault(ports: CapturePorts, capture: Capture): Promise<VaultPath | null> {
  const { sql, parameters } = compileCaptureHoldersQuery(capture);
  const found = await ports.index.query(sql, parameters);
  const first = found.rows[0]?.[0];
  return first === undefined || first === null ? null : createVaultPath(String(first));
}

/**
 * Writes the file at `path` unless something is there: then it is held when
 * that note is this capture, and null — try the next path — when it is not.
 * A failure with nothing there is the write's own, and is passed on.
 */
async function writeUnlessTaken(
  ports: CapturePorts,
  { path, file }: { path: VaultPath; file: CaptureFile },
): Promise<CaptureReceipt | null> {
  try {
    await ports.fs.createNote({ path, contents: file.content });
    return { path, outcome: 'written' };
  } catch (error) {
    const there = await readIfThere(ports, path);
    if (there === null) throw error;
    const properties = ports.markdown.frontmatterProperties(splitFrontmatter(there).frontmatter);
    return holdsCapture(properties, file) ? { path, outcome: 'in-vault' } : null;
  }
}

async function readIfThere({ fs }: CapturePorts, path: VaultPath): Promise<string | null> {
  try {
    return (await fs.readTextFile(path)).text;
  } catch {
    // Unreadable is taken as nothing there: the create's own failure is then the one passed on.
    return null;
  }
}
