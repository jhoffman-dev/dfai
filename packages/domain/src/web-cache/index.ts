/*
 * What the web build keeps of the vault in the browser (#667): pure policy
 * for the read cache, which the application keeps through a port.
 */
export {
  cachedReadBytes,
  cachedReadKey,
  cachedReadOf,
  evictionsToFit,
  fitsInReadCache,
  isCachedNoteStale,
  READ_CACHE_CAP_BYTES,
} from './read-cache-policy.ts';
export type { CachedReadFacts, CachedReadKind } from './read-cache-policy.ts';
export {
  carriesOnAt,
  isProvisionalVersion,
  isUnsent,
  nextInQueue,
  queuedSaveKey,
  queueSave,
  savesToSend,
} from './save-queue.ts';
export type { QueueDecision, QueuedSave, QueuedSaveState, SaveAsked } from './save-queue.ts';
