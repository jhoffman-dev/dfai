// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ClaimOutcome, MeetingsWaiting, SyncPhase } from '@dfai/domain';
import { createSyncStore, publishSync } from '../sync/sync-store.ts';
import type { SyncController } from '../sync/use-sync.ts';
import { createMeetingsWaitingStore, sayMeetingsWaiting } from './meetings-waiting-store.ts';
import { useMeetingsWaitingBanner } from './use-meetings-waiting-banner.ts';

const VAULT = '/Users/j/Notes';
const COUNTED: MeetingsWaiting = { kind: 'counted', mac: 'Studio', count: 2 };

function setUp({
  waiting = COUNTED,
  phase = { kind: 'ready' },
  outcome = { kind: 'claimed' },
}: { waiting?: MeetingsWaiting | null; phase?: SyncPhase; outcome?: ClaimOutcome } = {}) {
  const waitingStore = createMeetingsWaitingStore();
  const sync = createSyncStore();
  let answer: (outcome: ClaimOutcome) => void = () => undefined;
  const processHere = vi.fn(
    () =>
      new Promise<ClaimOutcome>((resolve) => {
        answer = resolve;
      }),
  );
  const controller = { phase, processHere } as unknown as SyncController;
  publishSync(sync, VAULT, controller);
  sayMeetingsWaiting(waitingStore, VAULT, waiting);
  const hook = renderHook(
    ({ vaultKey }: { vaultKey: string | null }) =>
      useMeetingsWaitingBanner({ waiting: waitingStore, sync, vaultKey }),
    { initialProps: { vaultKey: VAULT as string | null } },
  );
  const press = () => act(() => hook.result.current?.processHere?.onPress());
  const settle = async (with_: ClaimOutcome = outcome) => {
    await act(async () => answer(with_));
  };
  return { hook, processHere, press, settle, waitingStore, sync, controller };
}

describe('useMeetingsWaitingBanner (ADR-0035 parts 1 and 2, #176)', () => {
  it('offers "Process here" beside a count, while sync is healthy', () => {
    const { hook } = setUp();
    expect(hook.result.current).toMatchObject({
      line: '2 meetings waiting for Studio',
      processHere: { refused: null, busy: false, problem: null },
    });
  });

  it.each<[string, MeetingsWaiting, SyncPhase, RegExp]>([
    ['paused', { kind: 'uncounted', mac: 'Studio', why: 'paused' }, { kind: 'ready' }, /paused/],
    ['failing', COUNTED, { kind: 'failed', reason: 'offline', at: 1 }, /failing/],
    [
      'not pulled since launch or wake',
      { kind: 'uncounted', mac: 'Studio', why: 'no-pull' },
      { kind: 'ready' },
      /after the next sync/,
    ],
  ])('refuses it, and says which, while sync is %s', (_, waiting, phase, says) => {
    const { hook } = setUp({ waiting, phase });
    expect(hook.result.current?.processHere?.refused).toMatch(says);
  });

  it('shows the press under way, then nothing more once this Mac is named', async () => {
    const { hook, press, settle, processHere } = setUp();
    press();
    expect(hook.result.current?.processHere?.busy).toBe(true);
    expect(processHere).toHaveBeenCalledTimes(1);

    await settle({ kind: 'claimed' });

    expect(hook.result.current?.processHere).toMatchObject({ busy: false, problem: null });
  });

  it('says why a press named no Mac', async () => {
    const { hook, press, settle } = setUp();
    press();
    await settle({ kind: 'unreadable' });
    expect(hook.result.current?.processHere?.problem).toMatch(/cannot be read/);
  });

  it('says a claim that threw as a failed write', async () => {
    const { hook, controller } = setUp();
    vi.mocked(controller.processHere).mockRejectedValueOnce(new Error('the disk is full'));
    await act(async () => hook.result.current?.processHere?.onPress());
    expect(hook.result.current?.processHere?.problem).toMatch(/the disk is full$/);
  });

  it('goes once the import says nothing waits, as when the claim named this Mac', () => {
    const { hook, waitingStore } = setUp();
    act(() => sayMeetingsWaiting(waitingStore, VAULT, null));
    expect(hook.result.current).toBeNull();
  });

  it('shows no banner when none waits, and no button before sync says where the vault stands', () => {
    expect(setUp({ waiting: { ...COUNTED, count: 0 } }).hook.result.current).toBeNull();
    const { hook, sync } = setUp();
    act(() => publishSync(sync, VAULT, null));
    expect(hook.result.current).toEqual({
      line: '2 meetings waiting for Studio',
      processHere: null,
    });
  });

  it('keeps a press with the vault it was made in', async () => {
    const { hook, press, settle } = setUp();
    press();
    await settle({ kind: 'write-failed', reason: 'stale' });
    hook.rerender({ vaultKey: '/Users/j/Other' });
    expect(hook.result.current).toBeNull();
    hook.rerender({ vaultKey: VAULT });
    expect(hook.result.current?.processHere?.problem).toMatch(/stale$/);
  });
});
