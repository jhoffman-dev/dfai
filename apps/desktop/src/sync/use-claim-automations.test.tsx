// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ClaimRefusal, SyncPhase } from '@dfai/domain';
import { fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useClaimAutomations, type ClaimAutomationsOptions } from './use-claim-automations.ts';
import type { Exclusive } from './use-sync-runs.ts';

const VAULT = '/Users/j/Notes';
const PATH = '.atlas/settings.md';
const STUDIO = '---\nsync: github\nautomationsMac: mac-studio\nautomationsMacName: Studio\n---\n';

/** The vault's settings note on a host that writes it, and the order things happened in. */
function vaultWithSettings(text: string | null) {
  const file = { text, modified: 1, writes: 0 };
  const order: string[] = [];
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      file.text === null || !paths.includes(PATH)
        ? []
        : [{ path: PATH, text: file.text, modified: file.modified, size: 1 }],
    readTextFile: async () => ({ text: file.text ?? '', modified: file.modified }),
    writeTextFile: async ({ contents }) => {
      order.push('write');
      file.writes += 1;
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  });
  return { fs, file, order };
}

/** The vault's one git turn, recording what took it. */
function recordingExclusive(order: string[], open = true): Exclusive {
  return {
    current: () => null,
    open: () => open,
    start: async (kind, work) => {
      order.push(`turn:${kind}`);
      return work();
    },
    settle: async () => undefined,
  };
}

function setUp({
  settings = STUDIO,
  refusal = null,
  phase = { kind: 'ready' },
  thisMac = { id: 'mac-laptop', name: 'Laptop' },
  open = true,
}: {
  settings?: string | null;
  refusal?: ClaimRefusal | null;
  phase?: SyncPhase;
  thisMac?: ClaimAutomationsOptions['thisMac'];
  open?: boolean;
} = {}) {
  const vault = vaultWithSettings(settings);
  const activity = recordingActivity();
  const claimRefusal = vi.fn(async () => refusal);
  const run = vi.fn(async () => {
    vault.order.push('sync');
    return null;
  });
  const readAgain = vi.fn(async () => void vault.order.push('read again'));
  const options: ClaimAutomationsOptions = {
    fs: vault.fs,
    markdown: remarkMarkdown,
    vaultKey: VAULT,
    thisMac,
    syncs: true,
    phase,
    claimRefusal,
    exclusive: recordingExclusive(vault.order, open),
    activity,
    readAgain,
    run,
  };
  const hook = renderHook((props: ClaimAutomationsOptions) => useClaimAutomations(props), {
    initialProps: options,
  });
  return { ...vault, activity, claimRefusal, run, readAgain, hook, options };
}

describe('useClaimAutomations: "Process here" (ADR-0035 part 2, #176)', () => {
  it('claims in the vault’s git turn, says so in Activity, shows it, then syncs at once', async () => {
    const { hook, file, order, activity } = setUp();

    let outcome;
    await act(async () => {
      outcome = await hook.result.current.processHere();
    });

    expect(outcome).toEqual({ kind: 'claimed' });
    expect(file.text).toContain('automationsMac: mac-laptop');
    expect(file.text).toContain('automationsMacName: Laptop');
    expect(order).toEqual(['turn:claim', 'write', 'read again', 'sync']);
    expect(activity.reports.map((report) => report.message)).toEqual([
      'Laptop now runs the automations: meetings that waited are processed here after the next sync.',
    ]);
  });

  it('asks the gates with how sync last stood, and writes nothing while they refuse', async () => {
    const failed: SyncPhase = { kind: 'failed', reason: 'offline', at: 1 };
    const { hook, file, run, claimRefusal, activity } = setUp({
      refusal: 'failing',
      phase: failed,
    });

    let outcome;
    await act(async () => {
      outcome = await hook.result.current.processHere();
    });

    expect(outcome).toEqual({ kind: 'refused', why: 'failing' });
    expect(claimRefusal).toHaveBeenCalledWith(VAULT, failed);
    expect(file.writes).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(activity.reports).toEqual([]);
  });

  it('writes nothing, and does not sync, when the settings cannot be read', async () => {
    const { hook, file, run } = setUp({ settings: '---\nsync: [github\n---\n' });

    let outcome;
    await act(async () => {
      outcome = await hook.result.current.processHere();
    });

    expect(outcome).toEqual({ kind: 'unreadable' });
    expect(file.writes).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('warns in Activity when the write is refused, and does not sync', async () => {
    const { hook, run, activity, options } = setUp();
    const fs = {
      ...options.fs,
      writeTextFile: vi.fn().mockRejectedValue(new Error('the disk is full')),
    };
    hook.rerender({ ...options, fs });

    let outcome;
    await act(async () => {
      outcome = await hook.result.current.processHere();
    });

    expect(outcome).toMatchObject({ kind: 'write-failed' });
    expect(activity.reports).toMatchObject([{ level: 'warning' }]);
    expect(run).not.toHaveBeenCalled();
  });

  it('claims nothing for a vault being left, or before this Mac’s id is known', async () => {
    const leaving = setUp({ open: false });
    await act(async () => {
      await expect(leaving.hook.result.current.processHere()).resolves.toEqual({
        kind: 'vault-closed',
      });
    });
    const unknown = setUp({ thisMac: null });
    await act(async () => {
      await expect(unknown.hook.result.current.processHere()).resolves.toEqual({
        kind: 'refused',
        why: 'no-pull',
      });
    });
    expect(leaving.file.writes + unknown.file.writes).toBe(0);
  });

  it('does not read again or sync for a vault switched away from while it was written', async () => {
    const { hook, options, readAgain, run, fs, file } = setUp();
    let land: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const slow = {
      ...fs,
      writeTextFile: async (write: Parameters<typeof fs.writeTextFile>[0]) => {
        await landed;
        return fs.writeTextFile(write);
      },
    };
    hook.rerender({ ...options, fs: slow });

    let claimed: Promise<unknown> = Promise.resolve();
    act(() => {
      claimed = hook.result.current.processHere();
    });
    await vi.waitFor(() => expect(file.text).toBe(STUDIO));
    hook.rerender({ ...options, fs: slow, vaultKey: '/Users/j/Other' });
    land();
    await act(async () => {
      await claimed;
    });

    expect(readAgain).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('useClaimAutomations: Settings → Sync (ADR-0025)', () => {
  it('is the same claim, not gated: the person’s own move', async () => {
    const { hook, file, claimRefusal, run } = setUp({ refusal: 'paused' });

    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    expect(file.text).toContain('automationsMac: mac-laptop');
    expect(claimRefusal).not.toHaveBeenCalled();
  });
});
