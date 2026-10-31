/**
 * The local API's contract for meeting notes, and meetings sent in.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/**
 * A meeting, as its file says (ADR-0027). A file that failed import may lack
 * any of the contract's keys, so each is null when it is not there.
 */
export interface ApiMeeting {
  readonly path: string;
  /** The meeting's own `title`, else the note's name. */
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly date: string | null;
  /** Local time, `HH:MM`. */
  readonly start: string | null;
  readonly end: string | null;
  /** What sort of meeting the provider called it: Standup, 1:1… */
  readonly kind: string | null;
  readonly provider: string | null;
  /** The provider's own id for it. */
  readonly externalId: string | null;
  /**
   * How the import settled the file (`atlas_import_outcome`): `imported`,
   * `duplicate` or `error` (a stamp cleared by hand reads `imported`, as the
   * import reads it); `pending` while it waits in `Inbox/Meetings/` for the
   * Mac that imports; null for a meeting elsewhere the import never handled —
   * one filed before DFAI imported meetings, or made by hand.
   */
  readonly importOutcome: 'imported' | 'duplicate' | 'error' | 'pending' | null;
  /** Why it failed the import contract (`atlas_import_error`), or null when it imported. */
  readonly importError: string | null;
  /** The meeting this is a second copy of, as `atlas_duplicate_of` links it (`[[…]]`), or null. */
  readonly duplicateOf: string | null;
  /**
   * Where the summary Claude writes at the top stands (#186): `written` while
   * the block is the one it wrote; `edited` once the person changed it or took
   * it out; `pending` while the "After a meeting" rule has yet to write one;
   * `none` when no rule will (it is off, the meeting was not let in, has no
   * transcript, is older than the rule's 14 days, or was answered already).
   */
  readonly summary: 'written' | 'pending' | 'edited' | 'none';
  /** Why a pending summary waits — the rule's last failure, as its log says it — present only when pending. */
  readonly summaryPendingWhy?: string;
  /** Present, and true, for an archived meeting — only listed with `includeArchived`. */
  readonly archived?: true;
}

/**
 * A meeting as another program sends it (#93), in the shape n8n's workflow
 * assembles: mapped by the same rules its Code nodes run, into a meeting/v1
 * file in `Inbox/Meetings/`.
 */
export interface ApiReceiveMeetingBody {
  /** Who wrote the notes up: `gemini`, `granola`… — lower-case letters, digits and `-`. */
  readonly provider: string;
  /** The provider's own id for the meeting (the notes email's id): with `provider`, its identity. */
  readonly sourceId: string;
  readonly title: string;
  /** The notes email's subject, which states the meeting's day, and time if given. */
  readonly subject?: string;
  /** When the meeting began, `HH:MM` (or a date-time), when the sender knows it: read before anything else. */
  readonly start?: string;
  /** When the meeting ended, `HH:MM` (or a date-time). */
  readonly end?: string;
  /** When the notes arrived, an ISO instant: checked against the calendar event's end, or a start less the transcript's length, when nothing states one. */
  readonly arrived?: string;
  readonly attendees?: readonly {
    readonly name?: string | null;
    readonly email?: string | null;
  }[];
  /** The notes, with `## Summary`, `## Decisions`, `## Next steps` and `## Details` headings. */
  readonly summaryMd?: string;
  /** The provider's transcript, as it gives it. */
  readonly transcriptMd?: string;
  /** What sort of meeting it was: Standup, 1:1… */
  readonly category?: string;
  /** The IANA zone an instant is read in. Omitted: the zone this Mac keeps time in. */
  readonly timeZone?: string;
}

/**
 * What became of a sent meeting: `written` into `Inbox/Meetings/` at `path`,
 * or already `in-vault` at `path` (the same provider and id), nothing written.
 */
export interface ApiMeetingReceipt {
  readonly path: string;
  readonly outcome: 'written' | 'in-vault';
}

/** What the routes for meeting notes, and meetings sent in answer with. */
export type ApiMeetingSuccessBody =
  | {
      readonly meetings: readonly ApiMeeting[];
      readonly truncated: boolean;
      /** The `offset` for the next page, or null when this was the last. */
      readonly next: number | null;
    }
  | { readonly meeting: ApiMeetingReceipt };

/** The routes for meeting notes, and meetings sent in. */
export const MEETING_ROUTES = [
  {
    method: 'GET',
    path: '/v1/meetings',
    summary:
      'Meetings, newest first, with any import error. Query: since, limit, offset, includeArchived.',
  },
  {
    method: 'POST',
    path: '/v1/meetings',
    summary:
      'Send a meeting, as n8n assembles it: mapped and written into Inbox/Meetings, once per provider and id.',
  },
] as const;
