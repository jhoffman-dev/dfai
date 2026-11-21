import type { AssistApplyKind } from '../inbox/assist-apply.ts';

/**
 * Every kind of Inbox assist row, the two that move a note included (#911):
 * what tests of the moving kinds hand Apply. Test support only — no source
 * outside a test may import it (`every-assist-kind.reach.test.ts`), so
 * production writes only `APPLIABLE_ASSIST_KINDS` until #925 adds to that list.
 */
export const EVERY_ASSIST_KIND: ReadonlySet<AssistApplyKind> = new Set([
  'task',
  'due',
  'file',
  'link-person',
  'add-person',
  'duplicate',
]);
