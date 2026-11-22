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
  treeAsJson,
} from './slack-capture.ts';
export { HOSTILE_PIECES, hostileText, seededRandom } from './hostile-text.ts';
export {
  MARA_ID,
  slackPermalinkAnswer,
  slackRepliesAnswer,
  slackUserAnswer,
  TOBIAS_ID,
} from './slack-answers.ts';
export { EVERY_ASSIST_KIND } from './every-assist-kind.ts';
export {
  DUE_FORM_DAY,
  DUE_FORMS,
  EVERY_DUE_VALUE,
  LISTED_ONE_FORMS,
  ODD_DUE_FORMS,
  type DueForm,
  type OddDueForm,
} from './due-forms.ts';
/** The assistant's open-loop item, for the due cross-check (PR #930): production reaches it inside the domain. */
export { loopTask } from '../assistant/assistant-items.ts';
