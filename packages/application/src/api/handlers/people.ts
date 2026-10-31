import type { PEOPLE_ROUTES } from '../contract/people.ts';
import { duplicatesRoute, mergePeopleRoute } from '../people.ts';
import { type HandlerTable, vaultRoute, vaultWrite, renamed } from './route-handler.ts';

/** What answers each route for people: duplicates and merging them. */
export const PEOPLE_HANDLERS: HandlerTable<typeof PEOPLE_ROUTES> = {
  'GET /v1/people/duplicates': vaultRoute(duplicatesRoute),
  'POST /v1/people/merge': vaultWrite(mergePeopleRoute, renamed),
};
