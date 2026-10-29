// @vitest-environment jsdom
/**
 * Attack on PR #630 (#176): the claim's "not yet shared" against a vault
 * switch, with the real gates (`createFreshPullGate`) wired as
 * `usePulledFiles` wires them: `opened` on every draw, `claimUnshared`
 * drawn for the vault open now.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createFreshPullGate, fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useClaimAutomations, type ClaimAutomationsOptions } from './use-claim-automations.ts';
import type { Exclusive } from './use-sync-runs.ts';

const NOTES = '/Users/j/Notes';
const WORK = '/Users/j/Work';
const PATH = '.atlas/settings.md';
const STUDIO = '---\nsync: github\nautomationsMac: mac-studio\nautomationsMacName: Studio\n---\n';

function setUp() {
  const file = { text: STUDIO, modified: 1 };
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes(PATH)
        ? [{ path: PATH, text: file.text, modified: file.modified, size: 1 }]
        : [],
    readTextFile: async () => ({ text: file.text, modified: file.modified }),
    writeTextFile: async ({ contents }) => {
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  });
  const gate = createFreshPullGate({
    ports: {
      sleepClock: { asleepMs: async () => 0 },
      fs,
      markdown: remarkMarkdown,
      clock: { now: () => 1_000 },
      activity: recordingActivity(),
    },
    here: { thisMacId: () => 'mac-laptop', paused: () => true },
  });
  const activity = recordingActivity();
  const exclusive: Exclusive = {
    current: () => null,
    open: () => true,
    start: async (_kind, work) => work(),
    settle: async () => undefined,
  };
  const run = vi.fn(async () => null);
  /** The options as `useSync` draws them for the vault open now. */
  const drawn = (vaultKey: string): ClaimAutomationsOptions => {
    gate.opened(vaultKey);
    gate.inspected(vaultKey, true);
    return {
      fs,
      markdown: remarkMarkdown,
      vaultKey,
      thisMac: { id: 'mac-laptop', name: 'Laptop' },
      syncs: true,
      paused: true,
      phaseNow: () => ({ kind: 'ready' }),
      claimRefusal: gate.claimRefusal,
      claimed: gate.claimed,
      claimUnsharedNow: gate.claimUnshared,
      claimUnshared: gate.claimUnshared(vaultKey),
      exclusive,
      activity,
      readAgain: async () => undefined,
      run,
    };
  };
  const hook = renderHook((props: ClaimAutomationsOptions) => useClaimAutomations(props), {
    initialProps: drawn(NOTES),
  });
  const messages = () => activity.reports.map((report) => report.message);
  return { hook, drawn, messages, run, file };
}

describe('useClaimAutomations across a vault switch (PR #630 attack)', () => {
  it('never says this Mac runs the automations for a claim no sync has pushed', async () => {
    const { hook, drawn, messages, run, file } = setUp();
    // Settings → Sync while paused: written, not synced.
    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(file.text).toContain('automationsMac: mac-laptop'));
    hook.rerender(drawn(NOTES));
    expect(hook.result.current.pending).toMatchObject({ was: 'Studio' });

    // The person opens another vault, and comes back. Nothing has synced.
    hook.rerender(drawn(WORK));
    hook.rerender(drawn(NOTES));

    expect(run).not.toHaveBeenCalled();
    expect(messages()).not.toContain(
      'Laptop now runs the automations: meetings that waited are processed here.',
    );
  });

  it('still says the claim is not yet shared once the vault is opened again, while no sync has pushed it', async () => {
    const { hook, drawn, file } = setUp();
    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(file.text).toContain('automationsMac: mac-laptop'));
    hook.rerender(drawn(NOTES));

    hook.rerender(drawn(WORK));
    hook.rerender(drawn(NOTES));

    expect(hook.result.current.pending).toMatchObject({ was: 'Studio' });
  });
});

describe('useClaimAutomations: the Settings → Sync card’s problem (PR #630 attack)', () => {
  it('drops a refused claim’s problem once "Process here" has named this Mac', async () => {
    const { hook, drawn, file } = setUp();
    const options = drawn(NOTES);
    const fs = {
      ...options.fs,
      writeTextFile: async () => {
        throw new Error('the disk is full');
      },
    };
    hook.rerender({ ...options, fs });
    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(hook.result.current.problem).toMatch(/could not be named/));

    // The disk has room again; the person presses "Process here" on the Inbox, and it names this Mac.
    hook.rerender({ ...drawn(NOTES), claimRefusal: async () => null });
    await act(async () => {
      expect((await hook.result.current.processHere()).kind).toBe('claimed');
    });
    expect(file.text).toContain('automationsMac: mac-laptop');

    // The card must not go on saying this Mac could not be named.
    expect(hook.result.current.problem).toBeNull();
  });
});
