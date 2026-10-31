import type { ARCHIVE_ROUTES } from '../contract/archive.ts';
import { archiveListRoute, archiveRoute, unarchiveRoute } from '../archive.ts';
import { type HandlerTable, vaultRoute, vaultWrite } from './route-handler.ts';

/** What answers each route for the Archive. */
export const ARCHIVE_HANDLERS: HandlerTable<typeof ARCHIVE_ROUTES> = {
  'GET /v1/archive': vaultRoute(archiveListRoute),
  'POST /v1/archive': vaultWrite(archiveRoute),
  'POST /v1/unarchive': vaultWrite(unarchiveRoute),
};
