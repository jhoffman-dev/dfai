import { IMPORT_CONTRACT_KEY } from '../meetings/meeting-arrival.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import { CAPTURE_V1 } from './mapping/capture-payload.ts';

/** What the statements here start with, so a log or a stand-in index can tell them apart. */
export const CAPTURE_QUERY_MARK = '/* captures */';

/** Which message a capture is: its provider and `<channel>/<ts>` (ADR-0049). */
export interface CaptureIdentity {
  readonly provider: string;
  readonly externalId: string;
}

/**
 * The notes the index says hold a capture of this message, wherever they
 * are now: still in the Inbox, filed under a project, or archived. Any of
 * them means the message was saved already. The index can lag a write made a
 * moment ago, so whoever asks also reads the file at the capture's own path.
 */
export function compileCaptureHoldersQuery({
  provider,
  externalId,
}: CaptureIdentity): CompiledQuery {
  const holding = (key: string) =>
    `files.path IN (SELECT path FROM props WHERE key = '${key}' AND value_text = ?)`;
  return {
    sql: [
      `${CAPTURE_QUERY_MARK} SELECT files.path AS "path" FROM files`,
      `WHERE ${holding(IMPORT_CONTRACT_KEY)}`,
      `  AND ${holding('provider')}`,
      `  AND ${holding('external_id')}`,
      'ORDER BY files.path',
    ].join('\n'),
    parameters: [CAPTURE_V1, provider, externalId],
  };
}

/** Whether a note's frontmatter says it is a capture of this message. */
export function holdsCapture(
  properties: Readonly<Record<string, unknown>>,
  { provider, externalId }: CaptureIdentity,
): boolean {
  return (
    properties[IMPORT_CONTRACT_KEY] === CAPTURE_V1 &&
    properties['provider'] === provider &&
    properties['external_id'] === externalId
  );
}
