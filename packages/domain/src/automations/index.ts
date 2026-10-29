export {
  AUTOMATION_MARKER,
  AUTOMATION_MARKER_VALUE,
  automationFrontmatter,
  automationIdFor,
  automationIdKey,
  automationIdProblem,
  automationNameProblem,
  automationPathFor,
  describeAction,
  draftProblem,
  isAutomationNote,
  isAutomationPath,
  MAX_OLDER_THAN_DAYS,
  parseAutomationRule,
  setKeyProblem,
  setValueFromInput,
  wouldChange,
} from './automation-rule.ts';
export type {
  AutomationAction,
  AutomationDraft,
  AutomationRule,
  BrokenAutomation,
  SetValue,
} from './automation-rule.ts';
export { automationQuery, MAX_ACTIONS_PER_RUN, movingDate } from './automation-query.ts';
export { capFor, cappedLine, describePlan, planAutomation, planVerb } from './automation-plan.ts';
export type { AutomationPlan, PassedOver } from './automation-plan.ts';
export {
  describeSchedule,
  isDue,
  localTimeMs,
  localTimeOf,
  MAX_EVERY_HOURS,
  nextRunAfter,
  parseSchedule,
  printSchedule,
  slotAtOrBefore,
  WEEKDAYS,
} from './schedule.ts';
export type { LocalTime, Schedule, Weekday } from './schedule.ts';
export {
  currentPeriod,
  notePeriod,
  outputPeriod,
  periodKey,
  periodNoteMade,
  periodNoteOf,
  periodProperties,
  periodRecorded,
  PERIOD_ITEM_KEY,
  PERIOD_KEY,
  PERIOD_RULE_KEY,
  samePeriod,
  writesOneNoteAPeriod,
} from './output-period.ts';
export type { OutputPeriod, PeriodNote } from './output-period.ts';
export {
  BRIEF_SECTION_ITEMS,
  BRIEFS_CAPPED_REASON,
  briefDayOf,
  keepsCalendarClock,
  briefFolder,
  briefItem,
  briefNoteName,
  compileStampedBriefsQuery,
  MAX_BRIEFS_PER_RUN,
  meetingBriefData,
  meetingsToBrief,
  MORNING_BRIEF_FOLDER,
} from './morning-brief.ts';
export type { PageBrief, UnreadPage } from './morning-brief.ts';
export type { CitedStepData } from './cited-data.ts';
export {
  appendEntryToLog,
  appendLogEntry,
  futureMarkOf,
  formatLogEntry,
  lastRunOf,
  lastScheduleMark,
  lastUndoableRun,
  logPathFor,
  LOG_MARKER_VALUE,
  MAX_LOG_BYTES,
  MAX_LOG_ENTRIES,
  newLogText,
  parseRunLog,
  stillAsLeft,
  logEntryHeading,
  logEntrySummary,
} from './run-log.ts';
export type {
  ClaudeRunInfo,
  DoneAction,
  LogEntry,
  LoggedVersion,
  MeetingTally,
  SummaryOutcome,
  MovedVersion,
  PriorValue,
  ReplacedSummary,
  RunTrigger,
} from './run-log.ts';
export {
  CLAUDE_DATA,
  CLAUDE_NOTES_PER_RUN,
  claudeActionFields,
  isClaudeStepPrompt,
  isPromptPath,
  describeClaudeAction,
  outputHasItems,
  PROMPTS_DIRECTORY,
  readClaudeAction,
  readsData,
  withClaudeChoices,
  withClaudeData,
  withClaudeSkill,
  namedSkill,
  skillRunProblem,
} from './claude-step.ts';
export type {
  ClaudeAction,
  ClaudeApply,
  ClaudeData,
  ClaudeOutput,
  SkillRunProblem,
} from './claude-step.ts';
export {
  claudeAskRefusal,
  claudeRunAsks,
  claudeStepBudget,
  claudeStepDefaultModel,
  claudeStepModel,
  claudeStepOutput,
  DECLARED_STEP_ASKS_PER_HOUR,
  DECLARED_STEP_ASKS_PER_RUN,
  DECLARED_STEP_MODEL,
  SHARED_STEP_BUDGET,
  sharesAskAllowance,
} from './claude-step-budget.ts';
export type { ClaudeStepBudget } from './claude-step-budget.ts';
export {
  answerJson,
  checkDraft,
  citedBlockProblem,
  MAX_PROPOSALS_PER_ANSWER,
  registerProposalSchema,
} from './proposal-schema.ts';
export type {
  AnswerContext,
  AnsweredNote,
  AnsweredSummary,
  AnswerReading,
  AnswerSummarySchema,
  SummaryReading,
  AnswerVault,
  PendingTerm,
  CheckedProposal,
  DroppedItem,
  PromptData,
  ProposalDraft,
  ProposalSchema,
  Reading,
  RegisteredProposalSchema,
} from './proposal-schema.ts';
export { PROPOSAL_SCHEMAS, proposalSchemaNamed } from './proposal-schemas.ts';
export {
  EXCHANGE_TURNS,
  FOLLOW_UP_TAG,
  MEETING_ITEMS,
  MEETING_ITEMS_OUTPUT,
} from './meeting-items.ts';
export { meetingProposals, meetingReview } from './meeting-review.ts';
export { pendingTermOf } from './meeting-term-items.ts';
export {
  CLEANUP_REASON_WORDS,
  MEETING_ITEM_KEPT_KEY,
  meetingTasksFailingRules,
} from './meeting-cleanup.ts';
export type {
  CitedMeeting,
  CleanupCandidate,
  CleanupReason,
  MadeMeetingTask,
} from './meeting-cleanup.ts';
export {
  DIGEST_REDUCE_INSTRUCTIONS,
  DIGEST_REDUCE_PROMPT,
  digestReduceData,
  MEETING_DIGEST,
  MEETING_DIGEST_OUTPUT,
  meetingSummaryOf,
  partSummaries,
  readDigestReduce,
  reducePartMark,
  summarisedAlready,
  summaryActionItem,
  summaryDecisions,
  summaryListing,
  transcriptDigestOf,
} from './meeting-digest.ts';
export type { ListedOutcome } from './meeting-digest.ts';
export {
  compileProjectOptionsQuery,
  MAX_PROJECT_CHOICES,
  PROJECT_CHOICE_KEY,
  projectChoiceData,
  projectChoiceOutcome,
  projectOptionsOf,
  readProjectChoice,
  surestProjectChoice,
} from './meeting-project-choice.ts';
export type {
  ChoosingMeeting,
  ProjectChoice,
  ProjectChoiceOutcome,
  ProjectOption,
} from './meeting-project-choice.ts';
export { itemOwner } from './meeting-item-owner.ts';
export type { ItemOwner, OwnerDirectory } from './meeting-item-owner.ts';
export { compileMadeItemsQuery, linkedTaskOwner, madeTaskFor } from './made-items.ts';
export {
  decideMeetingItems,
  ownerNeededBy,
  REVIEW_CONFIDENCE_FLOOR,
  sameItemTitle,
  TASK_CONFIDENCE_FLOOR,
  vaultNamesItsOwner,
} from './meeting-item-apply.ts';
export type {
  LeftOutBecause,
  LinkedTask,
  MadeItem,
  MeetingDecisionClaim,
  MeetingItemCap,
  MeetingItemClaim,
  MeetingItemDecision,
  MeetingItemsDecision,
  MeetingItemsRun,
  OwnerSettings,
  ProposedBecause,
} from './meeting-item-apply.ts';
export {
  AFTER_A_MEETING_PROMPT,
  BUILT_IN_PROMPTS,
  builtInPromptAt,
  FRIDAY_REVIEW_PROMPT,
  MORNING_BRIEF_PROMPT,
  outdatedBuiltInPrompt,
  promptDigest,
  MEETING_EXTRACTION_PROMPT,
} from './built-in-prompts.ts';
export type { BuiltInPrompt } from './built-in-prompts.ts';
export { NOTE_ANSWER_INSTRUCTIONS, readNoteAnswer } from './note-answer.ts';
export {
  CLAUDE_NOTE_CHARACTERS,
  CLAUDE_STEP_QUESTION,
  CLAUDE_SYSTEM_MAX_BYTES,
  claudeSystemProblem,
  CLAUDE_TOTAL_NOTE_CHARACTERS,
  claudeStepSystem,
} from './claude-step-prompt.ts';
export { claudeWriteRefusal } from './claude-write-folder.ts';
export { atlasItemKey, claudeNewProposal, claudeProposalId } from './claude-proposal-id.ts';
export { leading, MAX_LOGGED_CHARACTERS, truncated } from './answer-limits.ts';
export {
  answeredMeetingOf,
  askedTurnsDigest,
  CLAUDE_ASKS_PER_RUN,
  claudeAsks,
  cutNotes,
  shownNotes,
} from './answered-note.ts';
export type { AnsweredMeeting, ClaudeAsks, NoteCut, NoteSkipped } from './answered-note.ts';
export type { NoteAnswer, NoteAnswerValue } from './note-answer.ts';
export {
  asksSpentInHour,
  backoffMinutes,
  dueTrigger,
  nextRunOf,
  ruleClockOf,
  NOTE_RUNS_PER_HOUR,
  noteRunsCappedProblem,
  noteRunsHeldUntil,
} from './automation-due.ts';
export {
  emptyLedger,
  isSchemaKey,
  LEDGER_MAX_AGE_DAYS,
  LEDGER_MAX_BYTES,
  MAX_DIGESTS_PER_PATH,
  MAX_LEDGER_RECORDS,
  MAX_STORED_ANSWERS,
  readHandledLedger,
  STORED_ANSWERS_MAX_BYTES,
  storedAnswerFor,
} from './handled-ledger.ts';
export type {
  AnsweredRecord,
  HandledLedger,
  LedgerMark,
  PathRecord,
  StoredAnswer,
  StoredAnswerDraft,
} from './handled-ledger.ts';
export {
  handledVersions,
  leftHandledNotes,
  movedHandledNotes,
  missedArrivals,
  noteTriggerHears,
  noteTriggerQueryProblem,
  parseNoteTrigger,
  printNoteTrigger,
  triggeringVersions,
  unhandledVersions,
} from './note-trigger.ts';
export type {
  HandledContext,
  HandledVersions,
  HeldNote,
  NoteEvent,
  NoteTrigger,
  NoteVersionRef,
} from './note-trigger.ts';
export {
  claudeFiledNoteProblem,
  loggedActionProblem,
  madeTaskMeeting,
  unarchiveProblem,
} from './undo-check.ts';
export { AUTOMATION_PRESETS, BLANK_AUTOMATION } from './presets.ts';
export {
  CITED_ITEMS_INSTRUCTIONS,
  keepCitedItems,
  nothingCitedProblem,
  UNCITED_REASON,
} from './cited-items.ts';
export type { CitedBody } from './cited-items.ts';
