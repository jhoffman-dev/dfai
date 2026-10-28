/*
 * Related notes and trails (P32-03): which notes are offered as related to a
 * note, where an accepted one's link is written, and how a trail is walked
 * and saved. All pure; the vectors come from the embeddings cache, which is
 * the application's.
 */
export {
  isOfferedAsRelated,
  linkedEitherWay,
  noteCentroid,
  rankRelatedNotes,
  relatedLimit,
  RELATED_NOTES,
} from './related-notes.ts';
export type { RelatableBlock, RelatedExclusions, RelatedScore } from './related-notes.ts';
export { RELATED_HEADING, withRelatedLink } from './related-section.ts';
export {
  canStepBack,
  canStepForward,
  standOn,
  startTrail,
  stepBack,
  stepForward,
  stepTo,
  trailMarkdown,
  trailNoteName,
  trailStep,
} from './trail.ts';
export type { Trail } from './trail.ts';
