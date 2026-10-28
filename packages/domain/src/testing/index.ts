/** What a test outside the package may use of its test support: `@dfai/domain/testing`. */
export { countedWork, countedWorkAsync, patternsMadeIn } from './counted-work.ts';
export { correlatedReads, type PlannedDatabase } from './query-plan.ts';
export { lineNoteBlocks } from './line-note-blocks.ts';
export {
  SLACK_CHANNEL,
  SLACK_PERMALINK,
  SLACK_REPLY_TS,
  SLACK_TS,
  slackCapture,
  slackSource,
} from './slack-capture.ts';
export { HOSTILE_PIECES, hostileText, seededRandom } from './hostile-text.ts';
