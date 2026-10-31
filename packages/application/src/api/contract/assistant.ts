/**
 * The local API's contract for the assistant's briefs, open loops and
 * proposals.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/**
 * Where an assistant item came from (P32-04): a wiki link that opens it.
 * `block` names the block itself (`[[Kickoff#^t0003]]`); `heading` the
 * heading over it, for a transcript turn the file left without an id, or with
 * one written twice — a read never writes one (ADR-0022); `note` the whole
 * note, also for a `source` block the index no longer holds.
 */
export interface ApiCitation {
  /** Null when the note's name holds what no wiki link can (`C# sync`): cite it by `path`. */
  readonly link: string | null;
  readonly kind: 'block' | 'heading' | 'note';
  /** The note it opens; null for a link that names no note in the vault. */
  readonly path: string | null;
}

/** A note an assistant answer names, cited. */
export interface ApiCitedNote {
  readonly path: string;
  readonly title: string;
  readonly cite: ApiCitation;
}

/** A meeting or a decision, with the day it is dated (null when undated). */
export interface ApiDatedNote extends ApiCitedNote {
  readonly date: string | null;
}

/** A decision, and the turn it came from when its `source` says. */
export interface ApiCitedDecision extends ApiDatedNote {
  readonly source: ApiCitation | null;
}

/** An open task, a waiting-for or a follow-up, as the assistant routes answer it. */
export interface ApiLoopTask extends ApiCitedNote {
  readonly status: string | null;
  readonly due: string | null;
  /** Due before the day asked about and not finished. */
  readonly overdue: boolean;
  /** Who a waiting-for waits on, as the task writes it; null otherwise. */
  readonly waitingOn: string | null;
  /** For a waiting-for, whole days since its file last changed; null otherwise. */
  readonly waitingDays: number | null;
  /** The meeting turn (or note) its `source` says it came from. */
  readonly source: ApiCitation | null;
}

/** A follow-up: how it was reached from the page, and through which meeting. */
export interface ApiFollowUp extends ApiLoopTask {
  /** `direct`: it names the page itself; `meeting`: it was reached only through a meeting of the page. */
  readonly via: 'direct' | 'meeting';
  /** The meeting it was reached through; null when `via` is `direct`. */
  readonly meeting: ApiCitedNote | null;
}

/** The page an assistant answer is about, cited. */
export interface ApiAssistantEntity extends ApiCitedNote {
  /** Its `type:`, as written. */
  readonly type: string;
}

/** A section of the page that could not be answered, and why. */
export interface ApiSectionProblem {
  readonly section: string;
  readonly problem: string;
}

/** `GET /v1/assistant/open-loops`: what is still open around a page. */
export interface ApiOpenLoops {
  readonly entity: ApiAssistantEntity;
  /** The day it was read, `YYYY-MM-DD`: what `overdue` and `waitingDays` count to. */
  readonly date: string;
  /** Open tasks linked with the page that are neither waiting-fors nor follow-ups. */
  readonly openTasks: readonly ApiLoopTask[];
  readonly waitingFor: readonly ApiLoopTask[];
  /**
   * Open `#follow-up` tasks linked with the page or one of its meetings. One
   * reached only through a meeting names no Person but the page's own.
   */
  readonly followUps: readonly ApiFollowUp[];
  readonly truncated: boolean;
  readonly problems: readonly ApiSectionProblem[];
}

/** `GET /v1/assistant/brief`: what to know about a page on a day. */
export interface ApiBrief extends ApiOpenLoops {
  /** The newest meeting dated on or before `date`; null when none. */
  readonly lastTouch: ApiDatedNote | null;
  readonly meetings: readonly ApiDatedNote[];
  /** Every task joined to `lastTouch`, finished or not, and its decisions. */
  readonly lastMeeting: {
    readonly meeting: ApiDatedNote;
    readonly tasks: readonly ApiLoopTask[];
    readonly decisions: readonly ApiCitedNote[];
  } | null;
  readonly decisions: readonly ApiCitedDecision[];
  /** Other notes linked with the page, changed in the 30 days up to `date`. */
  readonly mentions: readonly ApiCitedNote[];
  readonly related: readonly (ApiCitedNote & {
    readonly relation: 'person' | 'company' | 'project';
  })[];
}

/** One thing said in a meeting. */
export interface ApiSpeakerQuote {
  readonly speaker: string;
  readonly time: string | null;
  readonly quote: string;
  /** Whether the quote was cut. */
  readonly cut: boolean;
  readonly cite: ApiCitation;
}

/** `GET /v1/assistant/meetings`: a page's meetings, with who said what in them. */
export interface ApiAssistantMeetings {
  readonly entity: ApiAssistantEntity;
  readonly since: string | null;
  /** The last day a meeting may be dated: the day asked for, else the app's today. */
  readonly until: string;
  readonly about: string | null;
  /** The names a person's turns were matched by; null for a page that does not speak. */
  readonly speakers: readonly string[] | null;
  readonly meetings: readonly (ApiDatedNote & {
    readonly quotes: readonly ApiSpeakerQuote[];
    /** How many turns were wanted before the cap. */
    readonly matched: number;
  })[];
  readonly truncated: boolean;
  readonly problems: readonly ApiSectionProblem[];
}

/** `POST /v1/assistant/propose-tasks`: a meeting's items, drafted as proposals. */
export interface ApiProposedTasks {
  readonly meeting: string;
  /** The proposals written into Inbox/Proposals. */
  readonly proposed: readonly string[];
  /** How many the answer held that were proposed before, open or answered, and so were not again. */
  readonly alreadyProposed: number;
  /**
   * True when Claude was not asked: the meeting's words are those it was
   * drafted from before, and `alreadyProposed` counts what that made.
   */
  readonly unchanged: boolean;
  /** Items left out of the answer, each with why. */
  readonly dropped: readonly { readonly title: string; readonly reason: string }[];
  /** Why the meeting was not asked about at all, when it was not. */
  readonly left: readonly { readonly path: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

/** `POST /v1/assistant/make-dashboard`: a spec checked, and left as a proposal. */
export interface ApiProposedSpec {
  readonly kind: 'dashboard' | 'view';
  readonly title: string;
  /** The proposal written; null when it was not, and `problem` says why. */
  readonly proposal: string | null;
  /**
   * Why no proposal was written — the same spec proposed before, and what
   * became of it (`already accepted on 2026-10-23`), or a write that failed —
   * with that proposal's path when there is one. Null when one was written.
   */
  readonly problem: { readonly message: string; readonly proposal: string | null } | null;
}

/** What the routes for the assistant's briefs, open loops and proposals answer with. */
export type ApiAssistantSuccessBody =
  | { readonly brief: ApiBrief }
  | { readonly openLoops: ApiOpenLoops }
  | { readonly meetingQuotes: ApiAssistantMeetings }
  | { readonly proposedTasks: ApiProposedTasks }
  | { readonly proposingTasks: { readonly meeting: string; readonly running: true } }
  | { readonly proposedSpec: ApiProposedSpec };

/** The routes for the assistant's briefs, open loops and proposals. */
export const ASSISTANT_ROUTES = [
  {
    method: 'GET',
    path: '/v1/assistant/brief',
    summary:
      'A brief on a person, company, project, area or meeting for a day: last meeting, open loops, decisions, mentions — every item cited. Query: entity, date.',
  },
  {
    method: 'GET',
    path: '/v1/assistant/open-loops',
    summary:
      'Open tasks, waiting-fors and follow-ups around a person, company, project or area, each cited. Query: entity.',
  },
  {
    method: 'GET',
    path: '/v1/assistant/meetings',
    summary:
      'A page’s meetings with the turns that answer the question: speaker, quote, block link. Query: entity, since, about, limit.',
  },
  {
    method: 'POST',
    path: '/v1/assistant/propose-tasks',
    summary:
      'Draft a meeting’s tasks, waiting-fors, decisions and follow-ups as proposals, each citing its turn. Body: meeting.',
  },
  {
    method: 'POST',
    path: '/v1/assistant/make-dashboard',
    summary:
      'Check a dashboard or view spec and leave it as a proposal; only Accept in the app writes it into .atlas. Body: spec.',
  },
] as const;
