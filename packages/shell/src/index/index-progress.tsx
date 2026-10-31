import { useSyncExternalStore, type ComponentProps } from 'react';
import { INDEX_BATCH_SIZE } from '@dfai/application';
import { IndexSettings, indexStatusText } from '@dfai/ui';
import type { IndexProgressStore, IndexStatus } from './use-index.ts';

/**
 * The index's status with a build's progress in it. Only what calls this
 * re-renders as a build moves along: the two small components below, not the
 * window (#135).
 */
function useLiveIndexStatus(status: IndexStatus, progress: IndexProgressStore): IndexStatus {
  const { done, total } = useSyncExternalStore(progress.subscribe, progress.current);
  return status.kind === 'working' ? { kind: 'working', done, total } : status;
}

/**
 * How far a build of the index has got, drawn quietly at the foot of the
 * window: "Indexing 1,240 of 5,000…". Only for a build worth watching — the
 * refresh after a save is one batch and gone before it could be read. Not
 * said to a screen reader, which hears that indexing started and that it
 * finished from the window's status, not every batch in between.
 */
export function IndexProgressPill({
  status,
  progress,
}: {
  status: IndexStatus;
  progress: IndexProgressStore;
}) {
  const live = useLiveIndexStatus(status, progress);
  if (live.kind !== 'working' || live.total <= INDEX_BATCH_SIZE) return null;
  return (
    <p className="index-progress" aria-hidden="true">
      {indexStatusText(live)}
    </p>
  );
}

/** The Index card in Settings, saying how far a build has got while one runs. */
export function LiveIndexSettings({
  index,
  progress,
  ...card
}: Omit<ComponentProps<typeof IndexSettings>, 'index'> & {
  index: IndexStatus;
  progress: IndexProgressStore;
}) {
  return <IndexSettings index={useLiveIndexStatus(index, progress)} {...card} />;
}
