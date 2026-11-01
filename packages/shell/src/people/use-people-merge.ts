import { useLayoutEffect, useRef, useState } from 'react';
import {
  createPeopleMergeStore,
  peopleMergeCommands,
  type PeopleMergeCommands,
  type PeopleMergeDeps,
  type PeopleMergeStore,
} from './people-merge.ts';

/**
 * Merging people for the window (#464): one store for the merge's steps and
 * the list, and commands that stay the same function for the window's life —
 * the panes and the palette are handed them — while reading the vault open
 * at the moment they run.
 */
export function usePeopleMerge(deps: PeopleMergeDeps): {
  store: PeopleMergeStore;
  commands: PeopleMergeCommands;
} {
  const latest = useRef(deps);
  useLayoutEffect(() => {
    latest.current = deps;
  });
  const [merging] = useState(() => {
    const store = createPeopleMergeStore();
    return { store, commands: peopleMergeCommands(store, () => latest.current) };
  });
  return merging;
}
