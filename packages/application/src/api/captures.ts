import { CaptureRefusedError, readCapture } from '@dfai/domain';
import { CapturePathTakenError, receiveCapture } from '../capture/index.ts';
import { ApiError } from './api-error.ts';
import { bodyObject, optionalString } from './fields.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * Saves a Slack message, and its thread, sent under capture/v1 (#103,
 * ADR-0049) as an Inbox note or task in `Inbox/Captures/`. A new one is 201
 * `written`; a message the vault already holds is 200 `in-vault`, with the
 * note that holds it, and nothing is written. A payload the contract refuses
 * is `invalid`, naming every reason, and nothing is written.
 */
export async function receiveCaptureRoute(request: VaultRequest): Promise<RouteResult> {
  const { timeZone, ...payload } = bodyObject(request.body);
  const zone = optionalString({ timeZone }, 'timeZone') ?? request.timeZone;
  const receipt = await receiveCapture({
    ports: request,
    capture: captureOf(payload),
    timeZone: zone,
  }).catch(refusedCapture);
  // A capture found held is only held in the vault the request was for.
  request.assertStillOpen();
  return { status: receipt.outcome === 'written' ? 201 : 200, body: { capture: receipt } };
}

function captureOf(payload: unknown) {
  try {
    return readCapture(payload);
  } catch (error) {
    return refusedCapture(error);
  }
}

/** Why a capture was not taken, as the caller is told it. */
function refusedCapture(error: unknown): never {
  if (error instanceof CaptureRefusedError) throw new ApiError('invalid', error.message);
  if (error instanceof CapturePathTakenError) throw new ApiError('exists', error.message);
  throw error;
}
