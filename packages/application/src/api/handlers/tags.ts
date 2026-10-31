import type { TAG_ROUTES } from '../contract/tags.ts';
import { renameTagRoute, taggedNotesRoute, tagsRoute } from '../tags.ts';
import { type HandlerTable, vaultRoute, vaultWrite, renamed } from './route-handler.ts';

/** What answers each route for tags. */
export const TAG_HANDLERS: HandlerTable<typeof TAG_ROUTES> = {
  'GET /v1/tags': vaultRoute(tagsRoute),
  'GET /v1/tags/{tag}/notes': vaultRoute(taggedNotesRoute),
  'POST /v1/tags/{tag}/rename': vaultWrite(renameTagRoute, renamed),
};
