/**
 * The local API, as types.
 *
 * Three things are built against this file at once: the router that answers
 * requests inside the app (`./router.ts`), the Rust host that receives them on
 * localhost and forwards them here (`apps/desktop/src-tauri/src/api.rs`), and
 * the MCP server that other tools start and that speaks this API on their
 * behalf (`apps/mcp`). Keeping the contract in one typed place means a mismatch
 * between them is a type error rather than a surprise. ADR-0016 says why it is
 * shaped this way; `vault/docs/api/v1.md` says the same for people.
 *
 * Each area of the API keeps its own routes and shapes in `./contract/<area>.ts`;
 * this file only composes them. Everything here is data. No behaviour belongs
 * in this file.
 */

import type { ApiErrorBody } from './contract/wire.ts';
import { STATUS_ROUTES, type ApiStatusSuccessBody } from './contract/status.ts';
import { NOTE_ROUTES, type ApiNoteSuccessBody } from './contract/notes.ts';
import { SEARCH_ROUTES, type ApiSearchSuccessBody } from './contract/search.ts';
import { TYPE_ROUTES, type ApiTypeSuccessBody } from './contract/types.ts';
import { TEMPLATE_ROUTES, type ApiTemplateSuccessBody } from './contract/templates.ts';
import { SKILL_ROUTES, type ApiSkillSuccessBody } from './contract/skills.ts';
import { VIEW_ROUTES, type ApiViewSuccessBody } from './contract/views.ts';
import { QUERY_ROUTES, type ApiQuerySuccessBody } from './contract/query.ts';
import { CAPTURE_ROUTES, type ApiCaptureSuccessBody } from './contract/capture.ts';
import { PROFILE_ROUTES, type ApiProfileSuccessBody } from './contract/profile.ts';
import { SOURCE_ROUTES, type ApiSourceSuccessBody } from './contract/sources.ts';
import { ARTIFACT_ROUTES, type ApiArtifactSuccessBody } from './contract/artifacts.ts';
import { TAG_ROUTES, type ApiTagSuccessBody } from './contract/tags.ts';
import { PEOPLE_ROUTES, type ApiPeopleSuccessBody } from './contract/people.ts';
import { ARCHIVE_ROUTES, type ApiArchiveSuccessBody } from './contract/archive.ts';
import { INBOX_ROUTES, type ApiInboxSuccessBody } from './contract/inbox.ts';
import { TASK_ROUTES } from './contract/tasks.ts';
import { REVIEW_ROUTES, type ApiReviewSuccessBody } from './contract/review.ts';
import { TODAY_ROUTES, type ApiTodaySuccessBody } from './contract/today.ts';
import { ASSISTANT_ROUTES, type ApiAssistantSuccessBody } from './contract/assistant.ts';
import { AUTOMATION_ROUTES, type ApiAutomationSuccessBody } from './contract/automations.ts';
import { TERM_ROUTES, type ApiTermSuccessBody } from './contract/terms.ts';
import { MEETING_ROUTES, type ApiMeetingSuccessBody } from './contract/meetings.ts';
import {
  RECEIVED_CAPTURE_ROUTES,
  type ApiReceivedCaptureSuccessBody,
} from './contract/captures.ts';
import { CALENDAR_ROUTES, type ApiCalendarSuccessBody } from './contract/calendar.ts';
import { PROPOSAL_ROUTES, type ApiProposalSuccessBody } from './contract/proposals.ts';
import { GRANOLA_ROUTES, type ApiGranolaSuccessBody } from './contract/granola.ts';

export * from './contract/wire.ts';
export type * from './contract/status.ts';
export type * from './contract/notes.ts';
export type * from './contract/search.ts';
export type * from './contract/types.ts';
export type * from './contract/templates.ts';
export type * from './contract/skills.ts';
export type * from './contract/views.ts';
export type * from './contract/query.ts';
export type * from './contract/capture.ts';
export type * from './contract/profile.ts';
export type * from './contract/sources.ts';
export type * from './contract/artifacts.ts';
export type * from './contract/tags.ts';
export type * from './contract/people.ts';
export type * from './contract/archive.ts';
export type * from './contract/inbox.ts';
export type * from './contract/tasks.ts';
export type * from './contract/review.ts';
export type * from './contract/today.ts';
export type * from './contract/assistant.ts';
export type * from './contract/automations.ts';
export type * from './contract/terms.ts';
export type * from './contract/meetings.ts';
export type * from './contract/captures.ts';
export type * from './contract/calendar.ts';
export type * from './contract/proposals.ts';
export type * from './contract/granola.ts';

export interface ApiResponse {
  /** Echoes `ApiRequest.id`. */
  readonly id: string;
  readonly status: number;
  /** Serialised to JSON by the host exactly as given. */
  readonly body: ApiSuccessBody | ApiErrorBody;
}

/** Every route's answer: the union of each area's. */
export type ApiSuccessBody =
  | ApiStatusSuccessBody
  | ApiNoteSuccessBody
  | ApiSearchSuccessBody
  | ApiTypeSuccessBody
  | ApiTemplateSuccessBody
  | ApiSkillSuccessBody
  | ApiViewSuccessBody
  | ApiQuerySuccessBody
  | ApiCaptureSuccessBody
  | ApiProfileSuccessBody
  | ApiSourceSuccessBody
  | ApiArtifactSuccessBody
  | ApiTagSuccessBody
  | ApiPeopleSuccessBody
  | ApiArchiveSuccessBody
  | ApiInboxSuccessBody
  | ApiReviewSuccessBody
  | ApiTodaySuccessBody
  | ApiAssistantSuccessBody
  | ApiAutomationSuccessBody
  | ApiTermSuccessBody
  | ApiMeetingSuccessBody
  | ApiReceivedCaptureSuccessBody
  | ApiCalendarSuccessBody
  | ApiProposalSuccessBody
  | ApiGranolaSuccessBody;

/**
 * Every route, as the router and the MCP server both need to know them.
 *
 * `{path}` is a vault-relative note path, percent-encoded as one segment
 * (slashes as `%2F`), so `notes/Some%2FFolder%2FNote.md`. `{name}` is a file's
 * path inside an artifact's saved copy, a type's name, a template's name, or a skill's name,
 * encoded the same way. `{tag}` is a
 * tag's name, with or without its `#`, encoded the same way (`para%2Fresource`).
 * `{id}` is an automation's id, as `/v1/automations` lists it, encoded the same way.
 */
export const API_ROUTES = [
  ...STATUS_ROUTES,
  ...NOTE_ROUTES,
  ...SEARCH_ROUTES,
  ...TYPE_ROUTES,
  ...TEMPLATE_ROUTES,
  ...SKILL_ROUTES,
  ...VIEW_ROUTES,
  ...QUERY_ROUTES,
  ...CAPTURE_ROUTES,
  ...PROFILE_ROUTES,
  ...SOURCE_ROUTES,
  ...ARTIFACT_ROUTES,
  ...TAG_ROUTES,
  ...PEOPLE_ROUTES,
  ...ARCHIVE_ROUTES,
  ...INBOX_ROUTES,
  ...TASK_ROUTES,
  ...REVIEW_ROUTES,
  ...TODAY_ROUTES,
  ...ASSISTANT_ROUTES,
  ...AUTOMATION_ROUTES,
  ...TERM_ROUTES,
  ...MEETING_ROUTES,
  ...RECEIVED_CAPTURE_ROUTES,
  ...CALENDAR_ROUTES,
  ...PROPOSAL_ROUTES,
  ...GRANOLA_ROUTES,
] as const;

export type ApiRoute = (typeof API_ROUTES)[number];
