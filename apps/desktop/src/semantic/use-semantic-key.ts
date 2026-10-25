import { useEffect, useState } from 'react';
import type { BuildProgress, SemanticEngine } from '@dfai/application';

/** What a search by meaning needs of the engine: to ask, and to hear how the build goes. */
export type MeaningSource = Pick<SemanticEngine, 'search' | 'subscribe' | 'progress'>;

/** The longest the key goes without moving while the build moves. */
const AT_MOST_EVERY_MS = 1_000;
/** How much of the notes' total the build must have moved by for the key to move at once. */
const BY_FRACTION = 0.05;

const keyOf = (progress: BuildProgress | undefined): string =>
  progress === undefined ? '' : `${progress.done}/${progress.total}/${progress.failure ?? ''}`;

/** Whether `next` is news enough to move the key now, rather than at the next tick. */
function isNews(shown: BuildProgress, next: BuildProgress): boolean {
  // A build that began, ended or stopped, or whose size changed, is said at once.
  if (next.failure !== shown.failure || next.total === 0 || shown.total === 0) return true;
  return Math.abs(next.done - shown.done) >= Math.max(1, BY_FRACTION * next.total);
}

/**
 * How far the cache of meanings is built, as a key that moves with it: the
 * hits by meaning are searched again as notes are reached. It moves at once
 * for news (a build that began, ended or stopped, or moved by 5% of its notes)
 * and otherwise at most once a second, so a build writing every few notes does
 * not make a search of the whole cache for each write.
 *
 * `semantic` is null where no key is wanted — not searching by meaning — and
 * then nothing is subscribed to, and the build's writes draw nothing.
 */
export function useSemanticKey(semantic: MeaningSource | null): string {
  const [key, setKey] = useState(() => keyOf(semantic?.progress()));
  useEffect(() => {
    if (semantic === null) return undefined;
    let shown = semantic.progress();
    let latest = shown;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      shown = latest;
      setKey(keyOf(shown));
    };
    show();
    const unsubscribe = semantic.subscribe((progress) => {
      latest = progress;
      if (isNews(shown, progress)) show();
      else timer ??= setTimeout(show, AT_MOST_EVERY_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [semantic]);
  return key;
}
