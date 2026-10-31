import type { REVIEW_ROUTES } from '../contract/review.ts';
import { weeklyReviewRoute } from '../review.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for the weekly review. */
export const REVIEW_HANDLERS: HandlerTable<typeof REVIEW_ROUTES> = {
  'GET /v1/review/weekly': vaultRoute(weeklyReviewRoute),
};
