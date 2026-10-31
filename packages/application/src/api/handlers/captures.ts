import type { RECEIVED_CAPTURE_ROUTES } from '../contract/captures.ts';
import { receiveCaptureRoute } from '../captures.ts';
import { type HandlerTable, vaultWrite, created } from './route-handler.ts';

/** What answers each route for captures sent in from elsewhere. */
export const RECEIVED_CAPTURE_HANDLERS: HandlerTable<typeof RECEIVED_CAPTURE_ROUTES> = {
  'POST /v1/captures': vaultWrite(receiveCaptureRoute, created),
};
