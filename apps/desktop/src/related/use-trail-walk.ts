import { useCallback, useMemo, useRef, useState } from 'react';
import {
  createVaultPath,
  messageWithoutPaths,
  standOn,
  startTrail,
  stepBack,
  stepForward,
  stepTo,
  trailStep,
  type NoteLinks,
  type Trail,
  type VaultPath,
} from '@dfai/domain';
import { saveTrail, type IndexPort, type VaultFsPort } from '@dfai/application';
import type { RelatedPanelState, TrailNote, TrailWalk } from '@dfai/ui';
import type { TrailMemory } from './trail-memory.ts';

/**
 * The trail a tab walks (P32-03): started from a note, it is drawn over each
 * note it steps to, and stepping opens that note in the tab. A note opened
 * some other way is off the trail, and the bar is not drawn there; stepping
 * back onto a step draws it again.
 */
export function useTrailWalk({
  memory,
  trail,
  tab,
  path,
  links,
  related,
  titleOf,
  onOpenNote,
  fs,
  index,
}: {
  memory: TrailMemory;
  /** The tab's trail, as `memory` holds it now. */
  trail: Trail | null;
  tab: string;
  path: VaultPath | null;
  links: NoteLinks;
  related: RelatedPanelState;
  titleOf: (path: string) => string;
  onOpenNote: (path: VaultPath) => void;
  fs: VaultFsPort;
  index: Pick<IndexPort, 'manifest'>;
}): { walk: TrailWalk | undefined; start: () => void } {
  // What the last save came to, for the trail as it was saved: walked on, it is not that note.
  const [saved, setSaved] = useState<{
    for: Trail | null;
    note: TrailNote | null;
    problem: string | null;
  }>({ for: null, note: null, problem: null });
  // A save under way: pressed again meanwhile, it would make a second note.
  const saving = useRef(false);
  const here = trail !== null && path !== null && trailStep(trail) === path;

  const go = useCallback(
    (next: Trail) => {
      memory.set(tab, next);
      onOpenNote(createVaultPath(trailStep(next)));
    },
    [memory, tab, onOpenNote],
  );
  const start = useCallback(() => {
    if (path === null) return;
    memory.set(tab, startTrail(path));
  }, [memory, tab, path]);
  const save = useCallback(() => {
    if (trail === null || saving.current) return;
    saving.current = true;
    saveTrail({ fs, index, trail })
      .then((note) =>
        setSaved({ for: trail, note: { path: note, title: titleOf(note) }, problem: null }),
      )
      .catch((error: unknown) =>
        setSaved({ for: trail, note: null, problem: messageWithoutPaths(error) }),
      )
      .finally(() => {
        saving.current = false;
      });
  }, [trail, fs, index, titleOf]);
  const said = useMemo(
    () => (saved.for === trail ? saved : { note: null, problem: null }),
    [saved, trail],
  );

  const walk = useMemo<TrailWalk | undefined>(() => {
    if (trail === null || path === null || !here) return undefined;
    const noteOf = (step: string): TrailNote => ({
      path: createVaultPath(step),
      title: titleOf(step),
    });
    return {
      steps: trail.steps.map(noteOf),
      at: trail.at,
      linked: linkedSteps(links, path),
      related: related.kind === 'ready' ? related.notes : [],
      saved: said.note,
      problem: said.problem,
      onBack: () => go(stepBack(trail)),
      onForward: () => go(stepForward(trail)),
      onStandOn: (at) => go(standOn(trail, at)),
      onStep: (to) => go(stepTo(trail, to)),
      onSave: save,
      onOpenSaved: () => {
        if (said.note !== null) onOpenNote(said.note.path);
      },
      onEnd: () => memory.set(tab, null),
    };
  }, [here, trail, links, path, related, said, titleOf, go, save, onOpenNote, memory, tab]);

  return { walk, start };
}

/** The notes this one links with, either way, once each, by title. */
function linkedSteps(links: NoteLinks, path: VaultPath | null): TrailNote[] {
  const seen = new Map<string, TrailNote>();
  for (const entry of [...links.outgoing, ...links.incoming])
    if (entry.path !== path && !seen.has(entry.path))
      seen.set(entry.path, { path: entry.path, title: entry.title });
  return [...seen.values()].sort((left, right) => left.title.localeCompare(right.title));
}
