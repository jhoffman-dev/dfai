/**
 * Compile-time checks of the work that waits for the vault's settings (#901,
 * the review of #908): `pnpm typecheck` fails when they do not hold. Every
 * entry point of a switchable feature is classified in `KIND_OF` (an entry
 * given a feature and left out of it does not compile), and `working` holds
 * only the work entries, so a runner's `enabled` cannot be read from a row.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { EntryPoint, WorkEntry, WorkOffered } from './entry-points.ts';

describe('the work entries, at compile time', () => {
  it('are exactly the runners, timers and listeners of a switchable feature', () => {
    expectTypeOf<WorkEntry>().toEqualTypeOf<
      | 'kindleSync'
      | 'slackLinkOffer'
      | 'chatWork'
      | 'automationsRunner'
      | 'meetingSync'
      | 'granolaPull'
      | 'meetingImport'
    >();
    expectTypeOf<WorkEntry>().toMatchTypeOf<EntryPoint>();
  });

  it('are all that `working` holds: a drawn entry point cannot be read from it', () => {
    expectTypeOf<keyof WorkOffered>().toEqualTypeOf<WorkEntry>();
    // @ts-expect-error the Library's rows are drawn, not work: they are read from `offered`.
    expectTypeOf<WorkOffered['libraryPages']>().toBeBoolean();
    // @ts-expect-error a runner of no switchable feature follows the platform alone, through `offered`.
    expectTypeOf<WorkOffered['backgroundSync']>().toBeBoolean();
    // @ts-expect-error time blocks share Google's sign-in with Meetings, but are not Meetings'.
    expectTypeOf<WorkOffered['blockSync']>().toBeBoolean();
  });
});
