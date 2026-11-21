import { noteTitle, type VaultPath } from '../../domain/vault/index.ts';
import type { RemoteHead, StoredFile } from '../ports/index.ts';
import { isDerivedPath, saveLastSeen } from './last-seen.ts';
import type { PathPlan, Pulled } from './pull.ts';
import type { PathText, SyncDeps } from './sync-now.ts';

/** What one push sends: this device's changes, and the derived files that differ. */
export interface Outgoing {
  readonly notes: readonly PathText[];
  readonly noteDeletes: readonly VaultPath[];
  readonly derived: readonly PathText[];
  readonly derivedDeletes: readonly VaultPath[];
}

export const outgoingCount = (out: Outgoing): number =>
  out.notes.length + out.noteDeletes.length + out.derived.length + out.derivedDeletes.length;

/**
 * Everything to push after the pull: the files planned as pushes and the
 * conflict copies, read as they are now (a later edit to a file whose
 * remote did not change is pushed too), the deletes still deleted, and the
 * derived files whose content differs from the remote tree.
 */
export async function outgoing(deps: SyncDeps, pulled: Pulled): Promise<Outgoing> {
  const notes: PathText[] = [];
  const noteDeletes: VaultPath[] = [];
  const pushPaths = [
    ...pulled.plans.filter(({ decision }) => decision === 'push-local').map(({ path }) => path),
    ...pulled.conflicts.map(({ copy }) => copy),
  ];
  for (const path of pushPaths) {
    const file = await deps.store.get(path);
    if (file !== null) notes.push({ path, text: file.text });
  }
  for (const { path } of pulled.plans.filter(isPushDelete))
    if ((await deps.store.get(path)) === null) noteDeletes.push(path);
  return { notes, noteDeletes, ...(await derivedChanges(deps, pulled.remoteTree)) };
}

const isPushDelete = ({ decision }: PathPlan) => decision === 'push-delete';

async function derivedChanges(
  deps: SyncDeps,
  remoteTree: ReadonlyMap<VaultPath, string>,
): Promise<Pick<Outgoing, 'derived' | 'derivedDeletes'>> {
  if (deps.derivedFiles === undefined) return { derived: [], derivedDeletes: [] };
  const notes = (await deps.store.list())
    .filter(({ path }) => !isDerivedPath(path))
    .map(({ path, text }) => ({ path, text }));
  // Only `_index/` is sync's to write: anything else generated would overwrite a note.
  const generated = deps.derivedFiles(notes).filter(({ path }) => isDerivedPath(path));
  const derived: PathText[] = [];
  for (const file of generated)
    if (remoteTree.get(file.path) !== (await deps.hashBlob(file.text))) derived.push(file);
  const kept = new Set(generated.map(({ path }) => path));
  const derivedDeletes = [...remoteTree.keys()].filter(
    (path) => isDerivedPath(path) && !kept.has(path),
  );
  return { derived, derivedDeletes };
}

/** `Notes: <title>` for one note, `Notes: 3 changed` for more, `Index: refresh` for derived only. */
export function commitMessage(out: Outgoing): string {
  const paths = [...out.notes.map(({ path }) => path), ...out.noteDeletes];
  const [first] = paths;
  if (first === undefined) return 'Index: refresh';
  return paths.length === 1 ? `Notes: ${noteTitle(first)}` : `Notes: ${paths.length} changed`;
}

/**
 * After a push GitHub accepted: each pushed file takes its new blob sha as
 * its base, and is clean unless it was edited again meanwhile; the new tree
 * is recorded as seen.
 */
export async function settlePush(
  deps: SyncDeps,
  { pulled, out, head }: { pulled: Pulled; out: Outgoing; head: RemoteHead },
): Promise<void> {
  const tree = new Map(pulled.remoteTree);
  for (const path of [...out.noteDeletes, ...out.derivedDeletes]) tree.delete(path);
  for (const file of out.derived) tree.set(file.path, await deps.hashBlob(file.text));
  for (const pushed of out.notes) {
    const sha = await deps.hashBlob(pushed.text);
    tree.set(pushed.path, sha);
    const now = await deps.store.get(pushed.path);
    if (now !== null) await markPushed(deps, now, { sha, pushedText: pushed.text });
  }
  await saveLastSeen(deps.store, {
    identity: deps.remoteIdentity,
    head,
    entries: tree,
    heldBases: pulled.heldBases,
  });
}

async function markPushed(
  deps: SyncDeps,
  now: StoredFile,
  { sha, pushedText }: { sha: string; pushedText: string },
): Promise<void> {
  const file: StoredFile = { ...now, baseSha: sha, dirty: now.text !== pushedText };
  await deps.store.put(file);
  deps.session.applyWrite(file);
}
