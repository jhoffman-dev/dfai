// @vitest-environment jsdom
/**
 * The work clock and the page's own digests (#243): a write to the vault
 * hashes the text it expects (`crypto.subtle.digest`) before it asks the
 * host, and the hash is made on the browser's own thread, on the wall clock.
 * Not waited for, the page looked quiet in the gap, a frame was drawn and the
 * held layout reports were handed over there on a busy machine and after the
 * write on an idle one: Today's tick and choose counted a commit more or less
 * from run to run.
 */
import { describe, expect, it } from 'vitest';
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

type Report = (this: unknown, entries: { target: Element }[], observer: unknown) => void;

/** A resize observer whose reports come when the test says. */
class StandInObserver {
  readonly #report: Report;
  constructor(report: Report) {
    this.#report = report;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  reportOn(target: Element) {
    this.#report.call(this, [{ target }], this);
  }
}

/** Real milliseconds the stand-in digest takes: far longer than the clock's turns. */
const DIGEST_MS = 50;
const UNKNOWN = 'SHA-0';
/** A host command whose stand-in throws as it is called, not in the promise it returns. */
const BROKEN = 'broken_command';
const pageTimer = window.setTimeout.bind(window);
Object.assign(window, {
  ResizeObserver: class extends StandInObserver {},
  requestAnimationFrame: (callback: FrameRequestCallback) => pageTimer(() => callback(0), 0),
});
Object.defineProperty(window, 'crypto', {
  configurable: true,
  value: {
    subtle: {
      // An algorithm the browser does not know throws before any promise is made.
      digest: (algorithm: string) => {
        if (algorithm === UNKNOWN) throw new TypeError(`no such digest: ${algorithm}`);
        return new Promise<ArrayBuffer>((resolve) =>
          pageTimer(() => resolve(new ArrayBuffer(32)), DIGEST_MS),
        );
      },
    },
  },
});
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: (command: string) => {
    if (command === BROKEN) throw new Error(`${command} threw`);
    return Promise.resolve(null);
  },
};
installWorkClock({ startsAt: Date.UTC(2026, 5, 15, 9), virtual: true });

const clock = () => (window as unknown as { __workClock: Clock }).__workClock;
const host = () =>
  (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string): Promise<unknown> } })
    .__TAURI_INTERNALS__;

describe('the work clock, and a digest the page waits on (#243)', () => {
  it('hands a held layout report over only after the write that waited on a digest', async () => {
    const heard: string[] = [];
    const observer = new (
      window as unknown as { ResizeObserver: typeof StandInObserver }
    ).ResizeObserver(() => heard.push('reported'));
    clock().startCounting();
    // The tick's commit resized a row: its report is held.
    observer.reportOn(document.createElement('tr'));
    // The vault's write: the expected text's digest, then the host is asked.
    void crypto.subtle
      .digest('SHA-256', new Uint8Array([1]))
      .then(() => host().invoke('write_text_file'))
      .then(() => heard.push('written'));
    await clock().run(null, null, 0, 0);
    clock().stopCounting();

    // Observed: ['reported'] — the page looked quiet while the digest was made.
    expect(heard).toEqual(['written', 'reported']);
  });

  it('hands the digest to the page in the order it was asked, among the host’s answers', async () => {
    const heard: string[] = [];
    clock().startCounting();
    void crypto.subtle.digest('SHA-256', new Uint8Array([1])).then(() => heard.push('digest'));
    void host()
      .invoke('read_text_file')
      .then(() => heard.push('read'));
    await clock().run(null, null, 0, 0);
    clock().stopCounting();

    // The host answers at once and the digest takes its time, yet it was asked first.
    expect(heard).toEqual(['digest', 'read']);
  });

  // Observed: each waited at the head of the line, never answered, until the
  // clock's two-minute error; the test times out.
  it('answers a digest that throws as it is called, and goes on to the next question', async () => {
    const heard: string[] = [];
    clock().startCounting();
    crypto.subtle.digest(UNKNOWN, new Uint8Array([1])).then(
      () => heard.push('digested'),
      (error: unknown) => heard.push(`refused: ${(error as Error).message}`),
    );
    void host()
      .invoke('read_text_file')
      .then(() => heard.push('read'));
    await clock().run(null, null, 0, 0);
    clock().stopCounting();

    expect(heard).toEqual([`refused: no such digest: ${UNKNOWN}`, 'read']);
  }, 5_000);

  it('answers a host command that throws as it is called, and goes on to the next question', async () => {
    const heard: string[] = [];
    clock().startCounting();
    host()
      .invoke(BROKEN)
      .then(
        () => heard.push('answered'),
        (error: unknown) => heard.push(`refused: ${(error as Error).message}`),
      );
    void host()
      .invoke('read_text_file')
      .then(() => heard.push('read'));
    await clock().run(null, null, 0, 0);
    clock().stopCounting();

    expect(heard).toEqual([`refused: ${BROKEN} threw`, 'read']);
  }, 5_000);
});
