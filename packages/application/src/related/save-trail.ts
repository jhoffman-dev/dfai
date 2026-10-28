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

/** A trail of no steps was asked to be saved: there is nothing to write. */
export class EmptyTrailError extends Error {
  constructor() {
    super('A trail needs at least one step to be saved.');
    this.name = 'EmptyTrailError';
  }
}

/**
 * Saves a trail as an ordinary note of links (`trailMarkdown`), beside the
 * note it starts from and named after it — "Trail from Payroll ideas",
 * numbered when the name is taken. Every step walked is kept, those ahead of
 * where the walk stands too: they are part of the path. Reports where the
 * note landed.
 */
export async function saveTrail({
  fs,
  index,
  trail,
}: {
  fs: VaultFsPort;
  index: Pick<IndexPort, 'manifest'>;
  trail: Trail;
}): Promise<VaultPath> {
  const first = trail.steps[0];
  if (first === undefined) throw new EmptyTrailError();
  const notePaths = (await index.manifest()).map((entry) => createVaultPath(entry.path));
  const start = createVaultPath(first);
  const targets = trail.steps.map((step) => wikiLinkTargetFor(createVaultPath(step), notePaths));
  return createNoteFile({
    fs,
    name: trailNoteName(noteTitle(start)),
    beside: start,
    notePaths,
    contents: trailMarkdown(targets),
  });
}
