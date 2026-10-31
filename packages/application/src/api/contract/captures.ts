/**
 * The local API's contract for captures sent in from elsewhere.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/**
 * What became of a capture (#103, ADR-0049): `written` into `Inbox/Captures/`
 * at `path` as a note or a task, or already `in-vault` at `path` — the same
 * message, wherever it was filed since — with nothing written.
 */
export interface ApiCaptureReceipt {
  readonly path: string;
  readonly outcome: 'written' | 'in-vault';
}

/** Who wrote a Slack message or a reply, as capture/v1 names them. */
export interface ApiCaptureAuthor {
  /** Slack's user id: `U…`, `W…` or `B…`. */
  readonly id?: string;
  readonly name: string;
  /** Links the author to the Person note holding it as `email` or `other_emails`. */
  readonly email?: string;
}

/**
 * A Slack message sent to `POST /v1/captures` (#103, ADR-0049), as n8n, a
 * pasted link and `atlas_capture` all send it. The domain's `readCapture`
 * holds it to the contract; this only names its fields.
 */
export interface ApiReceiveCaptureBody {
  readonly contract: 'capture/v1';
  readonly kind: 'note' | 'task';
  readonly title?: string;
  readonly source: {
    readonly provider: 'slack';
    readonly channel: { readonly id: string; readonly name?: string };
    readonly ts: string;
    /** The message's permalink: it must point at `channel` and `ts`. */
    readonly url: string;
    readonly author: ApiCaptureAuthor;
  };
  /** The message as Slack sends it, in mrkdwn. */
  readonly text: string;
  readonly thread?: readonly {
    readonly ts: string;
    readonly author: ApiCaptureAuthor;
    readonly text: string;
    readonly url?: string;
  }[];
  readonly attachments?: readonly { readonly name: string; readonly url: string }[];
  /** Names for the `<@U…>` mentions in the text, by user id. */
  readonly users?: Readonly<Record<string, string>>;
  /** The IANA zone times are shown on. Omitted: the zone this Mac keeps time in. */
  readonly timeZone?: string;
}

/** What the routes for captures sent in from elsewhere answer with. */
export type ApiReceivedCaptureSuccessBody = { readonly capture: ApiCaptureReceipt };

/** The routes for captures sent in from elsewhere. */
export const RECEIVED_CAPTURE_ROUTES = [
  {
    method: 'POST',
    path: '/v1/captures',
    summary:
      'Save a Slack message, and its thread, as an Inbox note or task (capture/v1): once per message.',
  },
] as const;
