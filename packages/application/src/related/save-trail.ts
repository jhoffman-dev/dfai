import {
  createVaultPath,
  noteTitle,
  trailMarkdown,
  trailNoteName,
  wikiLinkTargetFor,
  type Trail,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { createNoteFile } from '../notes/create-note.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/** A trail with no step left in the vault was asked to be saved: there is nothing to write. */
export class EmptyTrailError extends Error {
  constructor() {
    super('A trail needs at least one step still in the vault to be saved.');
    this.name = 'EmptyTrailError';
  }
}

/** Where a saved trail landed, and how many of its steps had gone from the vault. */
export interface SavedTrail {
  readonly path: VaultPath;
  /** Steps deleted or renamed since they were walked: left out, the rest kept in order. */
  readonly gone: number;
}

/**
 * Saves a trail as an ordinary note of links (`trailMarkdown`), beside the
 * note it starts from and named after it — "Trail from Payroll ideas",
 * numbered when the name is taken. Every step walked is kept, those ahead of
 * where the walk stands too: they are part of the path — but a step no
 * longer in the vault is left out, as a link to it would open nothing.
 */
export async function saveTrail({
  fs,
  index,
  trail,
}: {
  fs: VaultFsPort;
  index: Pick<IndexPort, 'manifest'>;
  trail: Trail;
}): Promise<SavedTrail> {
  if (trail.steps.length === 0) throw new EmptyTrailError();
  const notePaths = (await index.manifest()).map((entry) => createVaultPath(entry.path));
  const there = new Set<string>(notePaths);
  const kept = trail.steps.filter((step) => there.has(step)).map(createVaultPath);
  const start = kept[0];
  if (start === undefined) throw new EmptyTrailError();
  const path = await createNoteFile({
    fs,
    name: trailNoteName(noteTitle(start)),
    beside: start,
    notePaths,
    contents: trailMarkdown(kept.map((step) => wikiLinkTargetFor(step, notePaths))),
  });
  return { path, gone: trail.steps.length - kept.length };
}
