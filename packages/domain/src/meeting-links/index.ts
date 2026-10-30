export { attendeeKey, emailDomain, matchAttendees, matchSpeakers } from './attendee-matching.ts';
export type {
  AmbiguousAttendee,
  AttendeeMatching,
  DirectoryCompany,
  DirectoryPerson,
  GuessedCompany,
  LinkedAttendee,
  MatchedBy,
  MatchedCompany,
  UnknownAttendee,
} from './attendee-matching.ts';
export {
  MEETING_COMPANIES_KEY,
  MEETING_LINK_KEYS,
  MEETING_LINK_WRITTEN_KEYS,
  MEETING_LINKS_MAKER,
  MEETING_PEOPLE_KEY,
  MEETING_PROJECT_KEY,
} from './meeting-link-keys.ts';
export {
  attendeesOf,
  linkedEntities,
  meetingProjectProposalId,
  namedSpeakers,
  planMeetingLinks,
} from './meeting-link-plan.ts';
export type {
  MeetingFiling,
  MeetingLinkInput,
  MeetingLinkPlan,
  PassedOverAttendee,
} from './meeting-link-plan.ts';
export {
  compileLinkDirectoryQuery,
  compileProjectTiesQuery,
  LINK_DIRECTORY_PAGE_SIZE,
  linkDirectoryOf,
} from './meeting-link-queries.ts';
export type { LinkDirectory, LinkDirectoryRow } from './meeting-link-queries.ts';
export { meetingLinkReport } from './meeting-link-report.ts';
export {
  compileAnyMarkQuery,
  compileMarkedAmongQuery,
  LINKING_FAILED,
  linkingFailed,
  linkingFailedStamp,
  linkingOwed,
  MARKED_AMONG_CHUNK,
  markedMeetingsOf,
  markRemoval,
  MEETING_LINKS_KEY,
  meetingsToRelink,
  RELINKS_PER_RUN,
} from './meeting-relink.ts';
export type { MeetingsNotLinked } from './meeting-relink.ts';
export {
  isFiledByDefault,
  NO_SERIES_PROJECT,
  planProjectBackfill,
  projectBackfillLine,
  projectBackfillUndoLine,
} from './meeting-project-backfill.ts';
export type { ProjectBackfillRow } from './meeting-project-backfill.ts';
export {
  CLOSED_PROJECT_STATUSES,
  isGenericTitle,
  isOpenFiling,
  isOwnerKnown,
  meetingParticipants,
  participantOwnerOf,
  SERIES_PEOPLE_OVERLAP,
  SERIES_WINDOW,
  seriesTitle,
  suggestMeetingProject,
  TWIN_START_MINUTES,
} from './meeting-series.ts';
export type {
  FiledProject,
  ParticipantOwner,
  ProjectSuggestion,
  SeriesMeeting,
} from './meeting-series.ts';
export {
  compileSeriesMeetingsQuery,
  compileSeriesParticipantsQuery,
  MEETING_SERIES_PAGE_SIZE,
  meetingsOnRecord,
  seriesNeighbours,
} from './meeting-series-queries.ts';
export type {
  MeetingOnRecord,
  SeriesMeetingRow,
  SeriesParticipantRow,
} from './meeting-series-queries.ts';
export type { MeetingLinkHappening } from './meeting-link-report.ts';
export { projectConfidence, rankProjects } from './project-ranking.ts';
export type { ProjectTie, RankedProject } from './project-ranking.ts';
export {
  isOwnerAttendee,
  isOwnerNote,
  ownerAddresses,
  ownerAddressesInUse,
  ownerNotAGroup,
  sameName,
} from './vault-owner.ts';
