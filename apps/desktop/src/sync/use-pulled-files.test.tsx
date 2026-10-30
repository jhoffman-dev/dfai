// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { fakeSleepClock, fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { usePulledFiles } from './use-pulled-files.ts';
import { githubHolding } from './github-settings.test-support.ts';

const VAULT = '/Users/j/Notes';
const THIS_MAC = 'mac-studio';
const SETTINGS = '---\nsync: github\nautomationsMac: mac-laptop\nautomationsMacName: Laptop\n---\n';

/**
 * #175 review: a wake or the pause shuts the gates without a new standing,
 * so the window is drawn again for each, and whatever shows a count asks again.
 */
function wire() {
  const sleep = fakeSleepClock();
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes('.atlas/settings.md')
        ? [{ path: '.atlas/settings.md', text: SETTINGS, modified: 1, size: 1 }]
        : [],
  });
  const clock = { now: () => 1_000 };
  const activity = recordingActivity();
  const hook = renderHook(
    ({ pausedNow }: { pausedNow: boolean }) =>
      usePulledFiles({
        vaultKey: VAULT,
        sleepClock: sleep.port,
        fs,
        markdown: remarkMarkdown,
        thisMacId: THIS_MAC,
        paused: () => pausedNow,
        pausedNow,
        clock,
        activity,
        gitOf: () => githubHolding(() => SETTINGS),
        onClaimUnshared: () => undefined,
      }),
    { initialProps: { pausedNow: false } },
  );
  return { hook, sleep };
}

describe('usePulledFiles: what shuts the gates without a pull (#175)', () => {
  it('says the Mac slept since the pull once a reading of the counter shows it, and stops once a pull after it completes', async () => {
    const { hook, sleep } = wire();
    const pull = async () => {
      const { pulls } = hook.result.current;
      const startedAsleepMs = await pulls.readAsleep();
      await act(async () => {
        pulls.inspected(VAULT, true);
        await pulls.ended(VAULT, { kind: 'synced' }, startedAsleepMs);
      });
    };
    await pull();
    expect(hook.result.current.gate.slept).toBe(false);

    sleep.sleep(8 * 60 * 60_000);
    await act(async () => {
      await hook.result.current.pulls.readAsleep();
    });
    expect(hook.result.current.gate.slept).toBe(true);

    await pull();
    expect(hook.result.current.gate.slept).toBe(false);
  });

  it('carries the pause as drawn', () => {
    const { hook } = wire();
    expect(hook.result.current.gate.paused).toBe(false);
    hook.rerender({ pausedNow: true });
    expect(hook.result.current.gate.paused).toBe(true);
  });
});
