// @vitest-environment jsdom
/**
 * Attacks on the work clock's held digests (#243, PR #651): many digests
 * interleaved with host calls, digests asked from a host answer's
 * continuation, digests that resolve out of order or reject later, a digest
 * called detached from `crypto.subtle`, and one that never comes.
 */
import { describe, expect, it, vi } from 'vitest';
import { installWorkClock } from './work-clock.ts';

interface Clock {
  run(
    source: string | null,
    arg: unknown,
    settleMs: number,
    limitMs: number,
  ): Promise<{ readyAfterMs: number }>;
  startCounting(): void;
  stopCounting(): Record<string, number>;
}

const pageTimer = window.setTimeout.bind(window);
/** `SLOW-<ms>` digests in that many real ms; `REJECT-<ms>` refuses after it; `NEVER` never answers. */
const standInDigest = (algorithm: string, given: Uint8Array) => {
  if (algorithm === 'NEVER') return new Promise<ArrayBuffer>(() => {});
  const [kind, ms] = algorithm.split('-');
  return new Promise<ArrayBuffer>((resolve, reject) =>
    pageTimer(() => {
      if (kind === 'REJECT') reject(new Error(`refused after ${ms}`));
      else resolve(new Uint8Array([given[0] ?? 0]).buffer);
    }, Number(ms)),
  );
};
Object.assign(window, {
  requestAnimationFrame: (callback: FrameRequestCallback) => pageTimer(() => callback(0), 0),
});
Object.defineProperty(window, 'crypto', {
  configurable: true,
  value: { subtle: { digest: standInDigest } },
});
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: (command: string) => Promise.resolve(command),
};
installWorkClock({ startsAt: Date.UTC(2026, 5, 15, 9), virtual: true });

const clock = () => (window as unknown as { __workClock: Clock }).__workClock;
const host = () =>
  (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string): Promise<unknown> } })
    .__TAURI_INTERNALS__;
// NaN when the buffer is empty, so a missing byte still fails the comparison.
const first = (buffer: ArrayBuffer): number => new Uint8Array(buffer)[0] ?? Number.NaN;

describe('the work clock, attacked through its digests (#651)', () => {
  it('hands concurrent digests that finish out of order to the page in the order asked', async () => {
    const heard: string[] = [];
    clock().startCounting();
    const delays = [40, 5, 25, 1, 15];
    delays.forEach((ms, at) => {
      void crypto.subtle
        .digest(`SLOW-${ms}`, new Uint8Array([at]))
        .then((value) => heard.push(`digest ${first(value)}`));
      void host()
        .invoke(`read ${at}`)
        .then(() => heard.push(`read ${at}`));
    });
    await clock().run(null, null, 0, 0);
    clock().stopCounting();

    expect(heard).toEqual(delays.flatMap((_, at) => [`digest ${at}`, `read ${at}`]));
  });

  it('answers a digest asked from a host answer’s continuation before a later-asked host call', async () => {
    const heard: string[] = [];
    clock().startCounting();
    void host()
      .invoke('read_text_file')
      .then(() => {
        heard.push('read');
        void crypto.subtle
          .digest('SLOW-30', new Uint8Array([7]))
          .then(() => host().invoke('write_text_file'))
          .then(() => heard.push('written'));
        void host()
          .invoke('stat')
          .then(() => heard.push('stat'));
      });
    await clock().run(null, null, 0, 0);
    const counted = clock().stopCounting();

    expect(heard).toEqual(['read', 'stat', 'written']);
    expect(counted).toEqual({ read_text_file: 1, stat: 1, write_text_file: 1 });
  });

  it('hands a digest that rejects later to the page as a refusal, in its turn', async () => {
    const heard: string[] = [];
    clock().startCounting();
    crypto.subtle.digest('REJECT-20', new Uint8Array([1])).then(
      () => heard.push('digested'),
      (error: unknown) => heard.push(`refused: ${(error as Error).message}`),
    );
    void host()
      .invoke('read_text_file')
      .then(() => heard.push('read'));
    await clock().run(null, null, 0, 0);
    clock().stopCounting();

    expect(heard).toEqual(['refused: refused after 20', 'read']);
  }, 5_000);

  it('does not hold the next question behind a digest the page never awaits', async () => {
    const heard: string[] = [];
    clock().startCounting();
    void crypto.subtle.digest('SLOW-10', new Uint8Array([1]));
    void host()
      .invoke('read_text_file')
      .then(() => heard.push('read'));
    await clock().run(null, null, 0, 0);
    clock().stopCounting();

    expect(heard).toEqual(['read']);
  }, 5_000);

  it('answers a digest called detached from crypto.subtle', async () => {
    const heard: number[] = [];
    const detached = crypto.subtle.digest;
    clock().startCounting();
    void detached('SLOW-5', new Uint8Array([9])).then((value) => heard.push(first(value)));
    await clock().run(null, null, 0, 0);
    clock().stopCounting();

    expect(heard).toEqual([9]);
  }, 5_000);

  it('names the digest when it gives up on one after two minutes', async () => {
    const realNow = performance.now.bind(performance);
    let calls = 0;
    // The first reading is the start; every later one is past two minutes.
    const now = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => realNow() + (calls++ === 0 ? 0 : 121_000));
    clock().startCounting();
    void crypto.subtle.digest('NEVER', new Uint8Array([1]));
    try {
      await expect(clock().run(null, null, 0, 0)).rejects.toThrow(
        'the work clock waited two minutes for crypto digest',
      );
    } finally {
      now.mockRestore();
      clock().stopCounting();
    }
  }, 5_000);
});
