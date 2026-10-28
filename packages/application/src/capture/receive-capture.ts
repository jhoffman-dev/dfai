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

/** Another note holds a capture's path; it is never written over, nor under another name. */
export class CapturePathTakenError extends Error {
  override readonly name = 'CapturePathTakenError';
}

/**
 * Saves a message another program read — n8n from Slack (#104), a pasted
 * link (#105), Claude (#106) — as an Inbox note or task (ADR-0049), its
 * authors linked to their Person notes when an address matches.
 *
 * A message the vault already holds, wherever it has been filed since, is
 * not written again: the index is asked, and since it lags a write made a
 * moment ago, so is the Captures folder, for a file whose name ends in the
 * message's key — however it was titled. Nothing is written over; the
 * folder is made when missing, and used as the vault spells it.
 *
 * Throws a {@link CapturePathTakenError} when another note holds its path.
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
  const arrived = await heldInFolder(ports, { folder, file });
  if (arrived !== null) return { path: arrived, outcome: 'in-vault' };
  // In the folder as the vault spells it: `inbox/Captures`, on a disk that does not tell them apart.
  const path = joinVaultPath(folder, vaultPathName(createVaultPath(file.path)));
  return writeUnlessTaken(ports, { path, file });
}

/** The first note the index says holds this message, or null. */
async function heldInVault(ports: CapturePorts, capture: Capture): Promise<VaultPath | null> {
  const { sql, parameters } = compileCaptureHoldersQuery(capture);
  const found = await ports.index.query(sql, parameters);
  const first = found.rows[0]?.[0];
  return first === undefined || first === null ? null : createVaultPath(String(first));
}

/**
 * A file in the Captures folder named for this message's key that holds it:
 * one written a moment ago, perhaps under another title, that the index has
 * not read yet. One listing, and a read only of a name that ends in the key.
 */
async function heldInFolder(
  ports: CapturePorts,
  { folder, file }: { folder: VaultPath; file: CaptureFile },
): Promise<VaultPath | null> {
  const ending = file.keyEnding.toLowerCase();
  for (const entry of await ports.fs.listDirectory(folder)) {
    if (entry.kind !== 'file' || !entry.path.toLowerCase().endsWith(ending)) continue;
    if (await holdsThisCapture(ports, { path: entry.path, file })) return entry.path;
  }
  return null;
}

/**
 * Writes the file at `path` unless something is there: held when that note
 * is this capture — another request wrote it in between — and refused when
 * it is not. A failure with nothing there is the write's own, and is passed on.
 */
async function writeUnlessTaken(
  ports: CapturePorts,
  { path, file }: { path: VaultPath; file: CaptureFile },
): Promise<CaptureReceipt> {
  try {
    await ports.fs.createNote({ path, contents: file.content });
    return { path, outcome: 'written' };
  } catch (error) {
    if ((await readIfThere(ports, path)) === null) throw error;
    if (await holdsThisCapture(ports, { path, file })) return { path, outcome: 'in-vault' };
    throw new CapturePathTakenError(
      `Another note holds the path of ${file.provider} ${file.externalId}; not writing it`,
    );
  }
}

async function holdsThisCapture(
  ports: CapturePorts,
  { path, file }: { path: VaultPath; file: CaptureFile },
): Promise<boolean> {
  const there = await readIfThere(ports, path);
  if (there === null) return false;
  return holdsCapture(
    ports.markdown.frontmatterProperties(splitFrontmatter(there).frontmatter),
    file,
  );
}

async function readIfThere({ fs }: CapturePorts, path: VaultPath): Promise<string | null> {
  try {
    return (await fs.readTextFile(path)).text;
  } catch {
    // Unreadable is taken as nothing there: the create's own failure is then the one passed on.
    return null;
  }
}
