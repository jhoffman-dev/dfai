/**
 * The local API's contract for automations.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

import type { DoneAction, NoteEvent, RunTrigger, SetValue } from '@dfai/domain';

/**
 * An automation (P25), as its file says it and as the Automations page lists
 * it. The API reads automations and never runs, undoes or edits one (ADR-0016).
 */
export interface ApiAutomation {
  /** What its log is kept under, and its key in `/v1/automations/{id}`. */
  readonly id: string;
  readonly name: string;
  /** Its file, in `.atlas/automations`. */
  readonly path: string;
  readonly enabled: boolean;
  /**
   * As its file writes it: `daily at 03:00`, `fridays at 15:00`, `every 6 hours`,
   * `on app open`, `manually`, or `a meeting is created or changed`.
   */
  readonly when: string;
  /** The note that sets it off (P29-01), or null for a rule on a clock, on opening or by hand. */
  readonly note: ApiNoteTrigger | null;
  /** The DFAI query naming its notes. */
  readonly which: string;
  /** Only notes not modified in this many days; null for any. */
  readonly olderThanDays: number | null;
  readonly do: 'archive' | 'set' | 'claude';
  /** What a `set` rule sets; null for any other. */
  readonly set: Readonly<Record<string, SetValue>> | null;
  /** What a `claude` rule asks Claude (P29-03); null for any other. */
  readonly claude: ApiClaudeStep | null;
  /** Its schedule in words, as the app shows it: "Every day at 03:00". */
  readonly schedule: string;
  /** Its action in words: "Archive", "Set status to done". */
  readonly action: string;
  /** Its newest run, or null when it has never run. */
  readonly lastRun: ApiAutomationLastRun | null;
  /**
   * When it next runs by itself, local time `YYYY-MM-DDTHH:MM:SS`; null when
   * it is off, paused until run by hand, or runs only on opening or by hand.
   */
  readonly nextRun: string | null;
  /**
   * The zone `nextRun` and its log's times are on, as an IANA name, when that
   * is the vault's plan zone rather than the Mac's own: the morning brief
   * keeps the primary calendar's clock (#587). Null for a rule on the Mac's.
   */
  readonly timeZone: string | null;
  /** Why the app's clock is not running it just now, or null. */
  readonly paused: string | null;
}

/** A rule a note sets off: a note of `type` being created, changed, or either. */
export interface ApiNoteTrigger {
  readonly type: string;
  readonly on: readonly NoteEvent[];
}

export interface ApiAutomationLastRun {
  /** Local time, `YYYY-MM-DDTHH:MM:SS`. */
  readonly at: string;
  /** `failed`: its query did not read, so it changed nothing. */
  readonly kind: 'run' | 'failed';
  readonly trigger: RunTrigger;
  /** "Archived 12 notes. Left 1 alone." */
  readonly summary: string;
}

/** A file in `.atlas/automations` that says it is a rule and cannot be read as one. It never runs. */
export interface ApiBrokenAutomation {
  readonly path: string;
  readonly name: string;
  readonly problem: string;
}

/**
 * A rule's Claude step, as its file writes it (P29-03): the prompt note, the
 * read tools it may call, and what it writes — proposals of a schema, or one
 * new note in `folder`. It never edits a note.
 */
export interface ApiClaudeStep {
  /** The prompt note, in `.atlas/prompts/`; for a step that names a skill, that skill's `SKILL.md`. */
  readonly prompt: string;
  /** The skill it asks with in place of a prompt note (#169), by name; null for a prompt note. */
  readonly skill: string | null;
  readonly tools: readonly string[];
  /** `note`, or the name of a proposal schema: `proposals`, or `meeting-items` (what Claude pulls out of a meeting). */
  readonly output: string;
  /** Where its one new note goes, for `output: note`; null otherwise. */
  readonly folder: string | null;
  /**
   * What DFAI hands it beside its notes: `weekly-review` (#40), `meeting-briefs` (#39, one
   * note per meeting of the day), or null for its notes alone.
   */
  readonly data: string | null;
}

/** One entry in a rule's log, as its file records it. */
export interface ApiAutomationLogEntry {
  readonly kind: 'run' | 'undo' | 'failed' | 'turnedOn' | 'seen' | 'letGo';
  /** Local time, `YYYY-MM-DDTHH:MM:SS`. */
  readonly at: string;
  /** "Ran on schedule", "Undid the run of …". */
  readonly heading: string;
  /** "Archived 12 notes. Left 1 alone." */
  readonly summary: string;
  /** What started a run; on `run` and `failed` only. */
  readonly trigger?: RunTrigger;
  /** When the run an `undo` undid ran. */
  readonly of?: string;
  /** Why a `failed` run could not start. */
  readonly problem?: string;
  /** Whether a `run` stopped at the most one run may do. */
  readonly capped?: boolean;
  /** On `letGo`: how many syncs' news a held-back rule let go; a run by hand takes the notes they named. */
  readonly count?: number;
  /** Each thing it did to a note: a move, or a property's value before and after. */
  readonly done: readonly DoneAction[];
  /** Notes it matched and left alone, with why. */
  readonly left: readonly { readonly path: string; readonly reason: string }[];
  /**
   * On a run of a rule a note sets off: each note version it handled, and
   * (`wrote`) the version its own write left. None of them sets it off again.
   */
  readonly versions?: readonly {
    readonly path: string;
    readonly digest: string;
    readonly wrote: boolean;
  }[];
  /** On a run of a rule a note sets off: paths a note it had handled left, ending their history. */
  readonly went?: readonly string[];
  /**
   * On a `run` or `failed` entry of a Claude step: the model asked, how long
   * it took, and (`cut`) each note it was shown only the start of — how many
   * characters of how many. An output that reads a long meeting in parts
   * (`meeting-items`) also says each item it left out of an answer it kept,
   * with why (`dropped`), and each it kept with a fault put right
   * (`adjusted`). `asks` is how many times the model was asked, once it was
   * (what the hourly cap counts); `alreadyMade` how many proposals were made
   * before; `warnings` what the person should know of the run.
   */
  readonly claude?: {
    readonly model: string;
    readonly ms: number;
    readonly cut?: readonly {
      readonly path: string;
      readonly shown: number;
      readonly of: number;
    }[];
    readonly asks?: number;
    readonly alreadyMade?: number;
    readonly dropped?: readonly { readonly title: string; readonly reason: string }[];
    readonly adjusted?: readonly { readonly title: string; readonly reason: string }[];
    readonly warnings?: readonly string[];
  };
}

/** What a rule would do if it ran now. Nothing is written to find out. */
export interface ApiAutomationPlan {
  readonly do: 'archive' | 'set' | 'claude';
  /** What a `set` rule would set on each note; null for any other. */
  readonly set: Readonly<Record<string, SetValue>> | null;
  /** The prompt and tools a `claude` rule's run would use; null for any other. Claude is not asked. */
  readonly claude: ApiClaudeStep | null;
  /** "Would archive 12 notes." */
  readonly summary: string;
  /** The notes it would act on, at most `cap`, in the order it would. */
  readonly notes: readonly { readonly path: string; readonly title: string }[];
  /** Notes it matched and would leave alone, with why: at most 500. */
  readonly passedOver: readonly { readonly path: string; readonly reason: string }[];
  /** How many more it would leave alone than `passedOver` lists. */
  readonly passedOverMore: number;
  /** True when more matched than one run may do; the rest wait for the next run. */
  readonly capped: boolean;
  /** The most one run acts on. */
  readonly cap: number;
  /**
   * The meetings it matched whose linking failed, which Run now links again
   * before anything else (#192): only for the "After a meeting" step
   * (`apply: mine`), and left out when every meeting is linked.
   */
  readonly notLinked?: {
    /** Newest first by `date`, at most 50. */
    readonly meetings: readonly { readonly path: string; readonly title: string }[];
    /** True when more are not linked than one run links; the rest wait for the next. */
    readonly capped: boolean;
  };
}

export interface ApiAutomationList {
  readonly automations: readonly ApiAutomation[];
  readonly broken: readonly ApiBrokenAutomation[];
}

/** The rule an answer is about. */
export interface ApiAutomationRef {
  readonly id: string;
  readonly name: string;
}

export interface ApiAutomationLog {
  readonly automation: ApiAutomationRef;
  /** Newest first. */
  readonly entries: readonly ApiAutomationLogEntry[];
  /** True when the log holds older entries than `limit` let through. */
  readonly truncated: boolean;
}

export interface ApiAutomationDryRun {
  readonly automation: ApiAutomationRef;
  readonly plan: ApiAutomationPlan;
}

/** What the routes for automations answer with. */
export type ApiAutomationSuccessBody = ApiAutomationList | ApiAutomationLog | ApiAutomationDryRun;

/** The routes for automations. */
export const AUTOMATION_ROUTES = [
  {
    method: 'GET',
    path: '/v1/automations',
    summary: 'Every automation: its rule, last and next run, and why one is paused or broken.',
  },
  {
    method: 'GET',
    path: '/v1/automations/{id}/log',
    summary: "An automation's log, newest first. Query: limit.",
  },
  {
    method: 'POST',
    path: '/v1/automations/{id}/dry-run',
    summary: 'What an automation would do if it ran now. Writes nothing.',
  },
] as const;
