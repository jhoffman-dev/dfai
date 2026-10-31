import { useMemo, useSyncExternalStore } from 'react';
import {
  noteTitle,
  trailStep,
  type NoteLinks,
  type VaultGraph,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort, VaultFsPort } from '@dfai/application';
import type { RelatedPanel, TrailWalk } from '@dfai/ui';
import { useRelatedNotes, type RelatedPorts } from './use-related-notes.ts';
import { useTrailWalk } from './use-trail-walk.ts';

/**
 * A pane's Related notes and the trail it walks, for its page (P32-03): the
 * section at the note's foot, and the bar over a note a trail stands on.
 * Neither is offered on a template, which is edited on its own (ADR-0026).
 */
export function useNoteRelated({
  ports,
  tab,
  path,
  isTemplate,
  graph,
  links,
  fs,
  index,
  editor,
  onOpenNote,
  onChanged,
}: {
  ports: RelatedPorts;
  tab: string;
  path: VaultPath | null;
  isTemplate: boolean;
  graph: VaultGraph | null;
  links: NoteLinks;
  fs: VaultFsPort;
  index: Pick<IndexPort, 'manifest'>;
  editor: { flush(): Promise<void>; reload(): void };
  onOpenNote: (path: VaultPath) => void;
  onChanged: () => void;
}): { related: RelatedPanel | undefined; trail: TrailWalk | undefined } {
  const note = isTemplate ? null : path;
  const titles = useMemo(
    () => new Map<string, string>((graph?.nodes ?? []).map((node) => [node.path, node.title])),
    [graph],
  );
  const titleOf = useMemo(
    () => (step: string) => titles.get(step) ?? noteTitle(step as VaultPath),
    [titles],
  );
  const trail = useSyncExternalStore(ports.trails.subscribe, () => ports.trails.get(tab));
  const trailHere = trail !== null && note !== null && trailStep(trail) === note;
  const found = useRelatedNotes({
    ports,
    graph,
    path: note,
    fs,
    index,
    editor,
    onChanged,
    trailHere,
  });
  const { walk, start } = useTrailWalk({
    memory: ports.trails,
    trail,
    tab,
    path: note,
    links,
    related: found.state,
    titleOf,
    onOpenNote,
    fs,
    index,
  });
  const related = useMemo<RelatedPanel | undefined>(
    () =>
      note === null
        ? undefined
        : {
            open: found.open,
            onToggle: found.toggle,
            state: found.state,
            onAccept: found.accept,
            onDismiss: found.dismiss,
            onStartTrail: start,
          },
    [note, found.open, found.toggle, found.state, found.accept, found.dismiss, start],
  );
  return { related, trail: walk };
}
