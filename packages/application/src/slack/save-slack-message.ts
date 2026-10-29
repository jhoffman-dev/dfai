import { readCapture, type CaptureKind } from '@dfai/domain';
import { receiveCapture, type CapturePorts, type CaptureReceipt } from '../capture/index.ts';

/**
 * Saves a message read from a pasted Slack link as an Inbox note or task
 * (#105), through the use-case `POST /v1/captures` runs (ADR-0049): one
 * contract, one dedupe. A message the vault already holds is not written
 * again, and the receipt names the note that holds it.
 */
export function saveSlackMessage({
  ports,
  payload,
  kind,
  timeZone,
}: {
  ports: CapturePorts;
  /** The payload {@link readSlackMessage} shaped. */
  payload: Readonly<Record<string, unknown>>;
  kind: CaptureKind;
  /** The zone the note shows times on. */
  timeZone: string;
}): Promise<CaptureReceipt> {
  return receiveCapture({ ports, capture: readCapture({ ...payload, kind }), timeZone });
}
