// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ClaimRefusal, SyncPhase, SyncReport } from '@dfai/domain';
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
  paused = false,
  synced = true,
}: {
  settings?: string | null;
  refusal?: ClaimRefusal | null;
  phase?: SyncPhase;
  thisMac?: ClaimAutomationsOptions['thisMac'];
  open?: boolean;
  paused?: boolean;
  /** Whether the sync the claim starts succeeds, pushing the claim. */
  synced?: boolean;
} = {}) {
  const vault = vaultWithSettings(settings);
  const activity = recordingActivity();
  const claimRefusal = vi.fn(async () => refusal);
  // What the gate knows: the claim is unshared from its write until a sync succeeds.
  const shared = { unshared: false };
  const claimed = vi.fn(() => {
    vault.order.push('claimed');
    shared.unshared = true;
  });
  const run = vi.fn(async (): Promise<SyncReport | null> => {
    vault.order.push('sync');
    if (!synced) return null;
    shared.unshared = false;
    return {} as SyncReport;
  });
  const readAgain = vi.fn(async () => void vault.order.push('read again'));
  const options: ClaimAutomationsOptions = {
    named: false,
    fs: vault.fs,
    markdown: remarkMarkdown,
    vaultKey: VAULT,
    thisMac,
    syncs: true,
    paused,
    phaseNow: () => phase,
    claimRefusal,
    claimed,
    claimUnsharedNow: () => shared.unshared,
    claimUnshared: false,
    exclusive: recordingExclusive(vault.order, open),
    activity,
    readAgain,
    run,
  };
  const hook = renderHook((props: ClaimAutomationsOptions) => useClaimAutomations(props), {
    initialProps: options,
  });
  /** Draws the hook as the window would after the gate changed. */
  const drawGate = (over: Partial<ClaimAutomationsOptions> = {}) =>
    hook.rerender({ ...options, claimUnshared: shared.unshared, ...over });
  const messages = () => activity.reports.map((report) => report.message);
  return {
    ...vault,
    activity,
    claimRefusal,
    claimed,
    run,
    readAgain,
    hook,
    options,
    drawGate,
    messages,
    shared,
  };
}

const press = async (hook: ReturnType<typeof setUp>['hook']) => {
  let outcome;
  await act(async () => {
    outcome = await hook.result.current.processHere();
  });
  return outcome;
};

describe('useClaimAutomations: "Process here" (ADR-0035 part 2, #176)', () => {
  it('claims in the vault’s git turn, tells the gate, shows it, then syncs at once', async () => {
    const { hook, file, order, messages, drawGate } = setUp();

    expect(await press(hook)).toEqual({ kind: 'claimed', was: 'Studio' });
    drawGate();

    expect(file.text).toContain('automationsMac: mac-laptop');
    expect(file.text).toContain('automationsMacName: Laptop');
    expect(order).toEqual(['turn:claim', 'write', 'claimed', 'read again', 'sync']);
    expect(messages()).toEqual([
      'Process here is set on this Mac but not yet shared with Studio.',
      'Laptop now runs the automations: meetings that waited are processed here.',
    ]);
  });

  it('offline, says the claim is set here but not yet shared, never that this Mac runs them (#630 review)', async () => {
    const { hook, messages, drawGate } = setUp({ synced: false });

    await press(hook);
    drawGate();

    expect(messages()).toEqual(['Process here is set on this Mac but not yet shared with Studio.']);
    expect(hook.result.current.pending).toMatchObject({ was: 'Studio' });
  });

  it('says it runs here once a later sync shares the claim, and only once', async () => {
    const { hook, messages, drawGate, shared } = setUp({ synced: false });
    await press(hook);
    drawGate();
    expect(hook.result.current.pending).not.toBeNull();

    // A scheduled sync succeeds later: the gate says the claim is shared.
    shared.unshared = false;
    drawGate();
    drawGate();

    expect(messages()).toEqual([
      'Process here is set on this Mac but not yet shared with Studio.',
      'Laptop now runs the automations: meetings that waited are processed here.',
    ]);
    expect(hook.result.current.pending).toBeNull();
  });

  it('never says this Mac runs them while another vault is open (#630 attack)', async () => {
    const { hook, messages, drawGate, shared } = setUp({ synced: false });
    await press(hook);
    drawGate();

    // Another vault opens; the gates hold nothing unshared for it.
    shared.unshared = false;
    drawGate({ vaultKey: '/Users/j/Other' });

    expect(messages()).toEqual(['Process here is set on this Mac but not yet shared with Studio.']);
  });

  it('asks the gates how sync stands at the moment it asks, not as last drawn (#630 review)', async () => {
    const failed: SyncPhase = { kind: 'failed', reason: 'offline', at: 1 };
    let now: SyncPhase = { kind: 'ready' };
    const { hook, options, claimRefusal } = setUp();
    hook.rerender({ ...options, phaseNow: () => now });
    // A look that was under way fails just before the claim's turn.
    now = failed;

    await press(hook);

    expect(claimRefusal).toHaveBeenCalledWith(VAULT, failed);
  });

  it('asks the gates with how sync last stood, and writes nothing while they refuse', async () => {
    const failed: SyncPhase = { kind: 'failed', reason: 'offline', at: 1 };
    const { hook, file, run, claimRefusal, activity } = setUp({
      refusal: 'failing',
      phase: failed,
    });

    expect(await press(hook)).toEqual({ kind: 'refused', why: 'failing' });
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
        why: 'mac-unknown',
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

  it('while sync is paused, writes the claim and leaves it unsent: nothing is pushed or pulled (#630 review)', async () => {
    const { hook, file, run, claimed } = setUp({ paused: true });

    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(file.text).toContain('automationsMac: mac-laptop'));
    await act(async () => undefined);

    expect(claimed).toHaveBeenCalledWith(VAULT, 'Studio');
    expect(run).not.toHaveBeenCalled();
  });

  it('is busy while the claim waits its turn, and says why a refused write named no Mac (#630 review)', async () => {
    const { hook, options } = setUp();
    let land: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const fs = {
      ...options.fs,
      writeTextFile: async () => {
        await landed;
        throw new Error('the disk is full');
      },
    };
    hook.rerender({ ...options, fs });

    act(() => hook.result.current.claimAutomations());
    expect(hook.result.current.claiming).toBe(true);
    land();
    await vi.waitFor(() => expect(hook.result.current.claiming).toBe(false));

    expect(hook.result.current.problem).toMatch(/could not be named.*the disk is full$/);
  });

  it('says a Mac whose id is not read yet cannot be named yet', async () => {
    const { hook, file } = setUp({ thisMac: null });

    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(hook.result.current.problem).toMatch(/id has not been read yet/));

    expect(file.writes).toBe(0);
  });

  it('clears what it said at the next claim', async () => {
    const { hook, options } = setUp({ thisMac: null });
    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(hook.result.current.problem).not.toBeNull());

    hook.rerender({ ...options, thisMac: { id: 'mac-laptop', name: 'Laptop' } });
    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(hook.result.current.claiming).toBe(false));

    expect(hook.result.current.problem).toBeNull();
  });

  it('drops "not read yet" once this Mac’s id is read, with no claim made since (#630 attack)', async () => {
    const { hook, options } = setUp({ thisMac: null });
    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(hook.result.current.problem).toMatch(/id has not been read yet/));

    hook.rerender({ ...options, thisMac: { id: 'mac-laptop', name: 'Laptop' } });

    expect(hook.result.current.problem).toBeNull();
  });

  it('drops a failed claim’s problem once the settings name this Mac by another path (#630 attack)', async () => {
    const { hook, options } = setUp();
    const fs = {
      ...options.fs,
      writeTextFile: vi.fn().mockRejectedValue(new Error('the disk is full')),
    };
    hook.rerender({ ...options, fs });
    act(() => hook.result.current.claimAutomations());
    await vi.waitFor(() => expect(hook.result.current.problem).toMatch(/disk is full/));

    // Named from Settings → Sync on reopening, or by set-up: the settings now name this Mac.
    hook.rerender({ ...options, fs, named: true });

    expect(hook.result.current.problem).toBeNull();
  });
});

describe('useClaimAutomations: a claim from before a restart (#630 review)', () => {
  const NOW_RUNS = 'Laptop now runs the automations: meetings that waited are processed here.';

  it('says this Mac runs the automations once git shows the claim shared', () => {
    const { hook, options, messages } = setUp();
    hook.rerender({ ...options, named: true, claimUnshared: true });
    // Shared, and this Mac still named: GitHub has its claim.
    hook.rerender({ ...options, named: true, claimUnshared: false });
    hook.rerender({ ...options, named: true, claimUnshared: false });
    expect(messages()).toEqual([NOW_RUNS]);
  });

  it('says it once for a claim this session made, though the gate is drawn unshared then shared', async () => {
    const { hook, messages, drawGate } = setUp();
    act(() => {
      void hook.result.current.processHere();
    });
    await vi.waitFor(() => expect(messages()).toContain(NOW_RUNS));
    drawGate({ claimUnshared: true });
    drawGate({ claimUnshared: false });
    expect(messages().filter((message) => message === NOW_RUNS)).toHaveLength(1);
  });

  it('says nothing when the claim stops being unshared because another Mac took over (PR #630 round 2 attack)', () => {
    // After a restart this Mac's old claim reads "not shared" once Studio's claim is fetched;
    // the sync that brings Studio's claim in ends it, with this Mac no longer named.
    const { hook, options, messages } = setUp();
    hook.rerender({ ...options, named: true, claimUnshared: false });
    hook.rerender({ ...options, named: true, claimUnshared: true });
    hook.rerender({ ...options, named: false, claimUnshared: false });
    expect(messages()).not.toContain(NOW_RUNS);
  });

  it('says nothing across a vault switch, or for a vault that never held one', () => {
    const { hook, options, messages } = setUp();
    hook.rerender({ ...options, claimUnshared: true });
    hook.rerender({ ...options, vaultKey: '/Users/j/Other', claimUnshared: false });
    hook.rerender({ ...options, claimUnshared: false });
    expect(messages()).toEqual([]);
  });
});
