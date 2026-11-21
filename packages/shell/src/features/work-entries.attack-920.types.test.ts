/**
 * Attack on #920 (#901, slice 3), at compile time: `working` holds only the
 * work entries, but a runner's `enabled` is a bare boolean, so it still
 * compiles when fed from `offered.*` — which ignores the settings wait — or
 * from a literal. `pnpm typecheck` fails here (each `@ts-expect-error` is
 * unused) until a runner can only be switched from `working`.
 */
import { describe, expect, it } from 'vitest';
import { EVERY_ENTRY_POINT, type EntryPointsOffered } from '@dfai/application';
import type { GranolaPullOptions } from '../granola/use-granola-pull.ts';
import type { AutomationsRunnerProps } from '../automations/automations-runner.tsx';

const offered: EntryPointsOffered = EVERY_ENTRY_POINT;

describe('a runner switched from `offered`, not `working` (attack #920)', () => {
  it('does not compile for the Granola pull or the automations runner', () => {
    const granola: Pick<GranolaPullOptions, 'enabled'> = {
      // @ts-expect-error `offered.granolaPull` is not held until the settings answer.
      enabled: offered.granolaPull,
    };
    const runner: Pick<AutomationsRunnerProps, 'enabled'> = {
      // @ts-expect-error `offered.automationsRunner` is not held until the settings answer.
      enabled: offered.automationsRunner,
    };
    expect([granola.enabled, runner.enabled]).toEqual([true, true]);
  });
});
