import {
  conflictCopyPath,
  decideSync,
  isoDate,
  type SyncDecision,
} from '../../domain/sync/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import type { RemoteHead, StoredFile } from '../ports/index.ts';
import { RemoteBranchMissingError, RemoteChangedError } from './errors.ts';
import { isDerivedPath, lastBase, loadLastSeen, saveLastSeen, type LastSeen } from './last-seen.ts';
import type { SyncConflict, SyncDeps } from './sync-now.ts';

/** One path's decision, with what it was decided over. */
export interface PathPlan {
  readonly path: VaultPath;
  readonly decision: SyncDecision;
  /** The base it was decided against. */
  readonly base: string | null;
  /** The file here when the plan was made; null when there was none. */
  readonly local: StoredFile | null;
  readonly remoteSha: string | null;
}

export interface Pulled {
  readonly head: RemoteHead | null;
  /** The whole remote tree at `head`, derived files included. */
  readonly remoteTree: ReadonlyMap<VaultPath, string>;
  /** Bases kept for paths whose remote change was not applied (see `LastSeen.heldBases`). */
  readonly heldBases: ReadonlyMap<VaultPath, string | null>;
  readonly plans: readonly PathPlan[];
  readonly pulled: number;
  readonly conflicts: readonly SyncConflict[];
}

/**
 * Brings the remote's changes here: decides every path three ways, applies
 * what comes from the remote to the store and then the session, and records
 * the tree seen. Pushes are only planned. A file that changes here while the
 * pull runs is left alone, for the next sync to decide afresh.
 */
export async function pull(deps: SyncDeps): Promise<Pulled> {
  const head = await deps.remote.head();
  const seen = await loadLastSeen(deps.store, deps.remoteIdentity);
  if (seen !== null && seen.identity !== deps.remoteIdentity) throw new RemoteChangedError();
  // A branch that was there and is gone is not a remote that deleted every note.
  if (head === null && seen?.head != null) throw new RemoteBranchMissingError();
  const remoteTree = await treeAt(deps, head, seen);
  const local = (await deps.store.list()).filter(({ path }) => !isDerivedPath(path));
  const plans = await planPaths(deps, { local, seen, remoteTree });
  const texts = await remoteTexts(deps, plans);
  const { skipped, ...applied } = await applyPlans(deps, { plans, texts, seen, remoteTree });
  const heldBases = new Map(skipped.map(({ path, base }) => [path, base]));
  await saveLastSeen(deps.store, {
    identity: deps.remoteIdentity,
    head,
    entries: remoteTree,
    heldBases,
  });
  return { head, remoteTree, heldBases, plans, ...applied };
}

/** The remote tree, read only when it is not the one last seen. */
async function treeAt(
  deps: SyncDeps,
  head: RemoteHead | null,
  seen: LastSeen | null,
): Promise<Map<VaultPath, string>> {
  if (head === null) return new Map();
  if (seen?.head?.treeSha === head.treeSha) return new Map(seen.entries);
  const entries = await deps.remote.tree(head.treeSha);
  return new Map(entries.map(({ path, sha }) => [path, sha]));
}

interface PlanInputs {
  readonly local: readonly StoredFile[];
  readonly seen: LastSeen | null;
  readonly remoteTree: ReadonlyMap<VaultPath, string>;
}

async function planPaths(deps: SyncDeps, inputs: PlanInputs): Promise<PathPlan[]> {
  const files = new Map(inputs.local.map((file) => [file.path, file]));
  const seenPaths = inputs.seen?.entries.keys() ?? [];
  const paths = new Set([...files.keys(), ...seenPaths, ...inputs.remoteTree.keys()]);
  const plans: PathPlan[] = [];
  for (const path of [...paths].sort()) {
    if (isDerivedPath(path)) continue;
    const file = files.get(path) ?? null;
    const remoteSha = inputs.remoteTree.get(path) ?? null;
    // A file here carries its own base. One deleted here, or deleted and made
    // again (no base of its own), is known by the tree last seen.
    const base = file?.baseSha ?? lastBase(inputs.seen, path);
    const decision = decideSync({ base, local: await localId(deps, file), remote: remoteSha });
    plans.push({ path, decision, base, local: file, remoteSha });
  }
  return plans;
}

/** The local side's blob name: the base when unchanged here, else the text's own. */
async function localId(deps: SyncDeps, file: StoredFile | null): Promise<string | null> {
  if (file === null) return null;
  if (!file.dirty && file.baseSha !== null) return file.baseSha;
  return deps.hashBlob(file.text);
}

async function remoteTexts(
  deps: SyncDeps,
  plans: readonly PathPlan[],
): Promise<Map<string, string>> {
  const shas = new Set<string>();
  for (const { decision, remoteSha } of plans)
    if ((decision === 'take-remote' || decision === 'conflict') && remoteSha !== null)
      shas.add(remoteSha);
  return shas.size === 0 ? new Map() : deps.remote.blobs([...shas]);
}

interface Applying {
  readonly plans: readonly PathPlan[];
  readonly texts: ReadonlyMap<string, string>;
  readonly seen: LastSeen | null;
  readonly remoteTree: ReadonlyMap<VaultPath, string>;
}

async function applyPlans(
  deps: SyncDeps,
  { plans, texts, seen, remoteTree }: Applying,
): Promise<{ pulled: number; conflicts: SyncConflict[]; skipped: PathPlan[] }> {
  const taken = new Set<VaultPath>([
    ...plans.map(({ path }) => path),
    ...(seen?.entries.keys() ?? []),
    ...remoteTree.keys(),
  ]);
  const date = isoDate(deps.clock.now());
  const conflicts: SyncConflict[] = [];
  const skipped: PathPlan[] = [];
  let pulled = 0;
  for (const plan of plans) {
    if (!writesHere(plan)) continue;
    if (!(await stillAsPlanned(deps, plan))) {
      skipped.push(plan);
      continue;
    }
    const remoteText = plan.remoteSha === null ? null : (texts.get(plan.remoteSha) ?? null);
    if (plan.decision === 'take-remote' && remoteText !== null) {
      await writeClean(deps, plan.path, remoteText, plan.remoteSha);
      pulled += 1;
    } else if (plan.decision === 'delete-local') {
      await deps.store.delete(plan.path);
      deps.session.applyDelete(plan.path);
      pulled += 1;
    } else if (plan.decision === 'conflict' && remoteText !== null && plan.local !== null) {
      const copy = conflictCopyPath({ path: plan.path, date, taken });
      taken.add(copy);
      await keepConflict(deps, { plan, local: plan.local, copy, remoteText });
      conflicts.push({ path: plan.path, copy });
      pulled += 1;
    } else if (plan.decision === 'unchanged') {
      await recordSameAsRemote(deps, plan);
    }
  }
  return { pulled, conflicts, skipped };
}

/** Whether applying the plan changes anything here. */
function writesHere({ decision, local, remoteSha }: PathPlan): boolean {
  if (decision === 'take-remote' || decision === 'delete-local' || decision === 'conflict')
    return true;
  if (decision !== 'unchanged' || local === null || remoteSha === null) return false;
  return local.dirty || local.baseSha !== remoteSha;
}

/** Whether the file here is still exactly as the plan saw it. */
async function stillAsPlanned(deps: SyncDeps, { path, local }: PathPlan): Promise<boolean> {
  const now = await deps.store.get(path);
  if (local === null || now === null) return local === now;
  return now.text === local.text && now.dirty === local.dirty && now.baseSha === local.baseSha;
}

async function writeClean(
  deps: SyncDeps,
  path: VaultPath,
  text: string,
  sha: string | null,
): Promise<void> {
  const file: StoredFile = { path, text, baseSha: sha, dirty: false };
  await deps.store.put(file);
  deps.session.applyWrite(file);
}

/** This device's text to the copy first, so a crash between the two writes loses nothing. */
async function keepConflict(
  deps: SyncDeps,
  {
    plan,
    local,
    copy,
    remoteText,
  }: { plan: PathPlan; local: StoredFile; copy: VaultPath; remoteText: string },
): Promise<void> {
  const mine: StoredFile = { path: copy, text: local.text, baseSha: null, dirty: true };
  await deps.store.put(mine);
  deps.session.applyWrite(mine);
  await writeClean(deps, plan.path, remoteText, plan.remoteSha);
}

/** Both sides already agree: the remote's sha becomes the file's base, and it is clean. */
async function recordSameAsRemote(
  deps: SyncDeps,
  { path, local, remoteSha }: PathPlan,
): Promise<void> {
  if (local === null || remoteSha === null) return;
  await writeClean(deps, path, local.text, remoteSha);
}
