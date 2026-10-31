import { memo, useMemo } from 'react';
import { useStore } from 'zustand';
import { noteTitle, type VaultPath } from '@dfai/domain';
import {
  MergePeopleDialog,
  PossibleDuplicatesDialog,
  type DuplicatesState,
  type MergeDialogState,
} from '@dfai/ui';
import type { MergeFlow, PeopleMergeCommands, PeopleMergeStore } from './people-merge.ts';
import { duplicatePairView, mergePreviewView } from './people-merge-views.ts';

/** Where the focus goes when the dialog closes and what opened it has gone. */
type FocusFallback = () => HTMLElement | null;

function dialogState(flow: MergeFlow): MergeDialogState {
  switch (flow.kind) {
    case 'picking':
      return { kind: 'picking', choices: flow.choices };
    case 'checking':
      return { kind: 'checking' };
    case 'refused':
      return flow;
    case 'previewed':
    case 'merging':
      return { kind: flow.kind, preview: mergePreviewView(flow.preview) };
  }
}

/** Whose merge it is, for the picker's title. */
/** People's names as a title says them: "Mara", "Mara and Marra Quill", "Mara, Ana and Tobias Fenn". */
function namesOf(paths: readonly VaultPath[]): string {
  const names = paths.map(noteTitle);
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function subjectOf(flow: MergeFlow): string {
  if (flow.kind === 'picking') return namesOf(flow.subjects);
  if (flow.kind === 'checking') return flow.request.merge.map(noteTitle).join(', ');
  return '';
}

/**
 * The merge question, drawn from its own store (ADR-0040): a step of the
 * merge draws this dialog and nothing else in the window.
 */
export const MergePeopleSlot = memo(function MergePeopleSlot({
  store,
  commands,
  fallbackFocus,
}: {
  store: PeopleMergeStore;
  commands: PeopleMergeCommands;
  fallbackFocus?: FocusFallback;
}) {
  const flow = useStore(store, (state) => state.merge);
  const fromList = useStore(store, (state) => state.fromList);
  const state = useMemo(() => (flow === null ? null : dialogState(flow)), [flow]);
  if (flow === null || state === null) return null;
  return (
    <MergePeopleDialog
      subject={subjectOf(flow)}
      state={state}
      onPick={commands.pick}
      {...(fromList && flow.kind === 'previewed' && { onSwap: commands.swap })}
      onConfirm={commands.confirm}
      onClose={commands.closeMerge}
      {...(fallbackFocus !== undefined && { fallbackFocus })}
    />
  );
});

/** The people who may be one, drawn from the same store. */
export const PossibleDuplicatesSlot = memo(function PossibleDuplicatesSlot({
  store,
  commands,
  onOpen,
  fallbackFocus,
}: {
  store: PeopleMergeStore;
  commands: PeopleMergeCommands;
  onOpen: (path: VaultPath) => void;
  fallbackFocus?: FocusFallback;
}) {
  const flow = useStore(store, (state) => state.duplicates);
  const state = useMemo<DuplicatesState>(
    () =>
      flow.kind === 'ready' ? { kind: 'ready', pairs: flow.pairs.map(duplicatePairView) } : flow,
    [flow],
  );
  return (
    <PossibleDuplicatesDialog
      state={state}
      onOpen={(path) => {
        commands.closeDuplicates();
        onOpen(path as VaultPath);
      }}
      onMerge={commands.mergePair}
      onDismiss={commands.dismiss}
      onClose={commands.closeDuplicates}
      {...(fallbackFocus !== undefined && { fallbackFocus })}
    />
  );
});
