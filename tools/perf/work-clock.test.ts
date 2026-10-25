// @vitest-environment jsdom
/**
 * The work clock's rules (`work-clock.ts`), in a stand-in window: time moves
 * only when the harness moves it, timers fire in the order they are due, and
 * the host's answers reach the app in the order it asked, however they arrive.
 */
import { setTimeout as wallClockDelay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { installWorkClock } from './work-clock.ts';

interface Clock {
  run(
    source: string | null,
    arg: unknown,
    settleMs: number,
    limitMs: number,
    untrackedMs?: number,
  ): Promise<{ readyAfterMs: number }>;
  startCounting(): void;
  stopCounting(): Record<string, number>;
}

const STARTS_AT = Date.UTC(2026, 5, 15, 9);
const realSetTimeout = globalThis.setTimeout;

/** A host whose answers come back when the test says, not in the order asked. */
function installSlowHost() {
  const pending = new Map<string, (value: unknown) => void>();
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (command: string) =>
      new Promise((resolve) => {
        pending.set(command, resolve);
      }),
  };
  return {
    answer: (command: string) => pending.get(command)?.(`${command} answered`),
  };
}

const clock = () => (window as unknown as { __workClock: Clock }).__workClock;
const invoke = (command: string) =>
  (
    window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } }
  ).__TAURI_INTERNALS__.invoke(command);
const aMoment = () => new Promise((resolve) => realSetTimeout(resolve, 20));

describe('the work clock', () => {
  const host = installSlowHost();
  // jsdom draws its frames on the page's own timers, which the clock holds: it waits on plain ones instead.
  Reflect.deleteProperty(window, 'requestAnimationFrame');
  installWorkClock({ startsAt: STARTS_AT, virtual: true });

  it('holds every timer until time is moved on, then fires them in the order they are due', async () => {
    const fired: string[] = [];
    setTimeout(() => fired.push('late'), 300);
    setTimeout(() => fired.push('early'), 100);
    requestAnimationFrame(() => fired.push('frame'));
    await aMoment();
    expect(fired).toEqual([]);
    await clock().run(null, null, 200, 0);
    expect(fired).toEqual(['frame', 'early']);
    await clock().run(null, null, 200, 0);
    expect(fired).toEqual(['frame', 'early', 'late']);
  });

  it('gives Date the virtual time from the day it starts at', async () => {
    const before = Date.now();
    expect(before).toBeGreaterThanOrEqual(STARTS_AT);
    await clock().run(null, null, 5_000, 0);
    expect(Date.now() - before).toBe(5_000);
    expect(new Date().getTime()).toBe(Date.now());
  });

  it('hands the host’s answers over in the order they were asked for', async () => {
    const heard: unknown[] = [];
    void invoke('first').then((value) => heard.push(value));
    void invoke('second').then((value) => heard.push(value));
    host.answer('second');
    await aMoment();
    host.answer('first');
    await clock().run(null, null, 0, 0);
    expect(heard).toEqual(['first answered', 'second answered']);
  });

  it('runs until the page says it is ready, and says how long that took', async () => {
    setTimeout(() => document.body.setAttribute('data-ready', 'yes'), 250);
    const ran = await clock().run(
      '() => document.body.getAttribute("data-ready") === "yes"',
      null,
      0,
      1_000,
    );
    expect(ran.readyAfterMs).toBe(250);
  });

  it('waits on the wall clock, time held still, for work it does not hold', async () => {
    const timerFired: string[] = [];
    setTimeout(() => timerFired.push('timer'), 100);
    // Work the clock does not hold (a read of a Blob, in the app): it settles on the wall clock.
    void wallClockDelay(300).then(() => document.body.setAttribute('data-read', 'yes'));
    const ran = await clock().run(
      '() => document.body.getAttribute("data-read") === "yes"',
      null,
      0,
      1_000,
      5_000,
    );
    expect(ran.readyAfterMs).toBe(0);
    expect(timerFired).toEqual([]);
  });

  it('fails, rather than waits for ever, when the page is never ready', async () => {
    await expect(clock().run('() => false', null, 0, 500)).rejects.toThrow(
      'not ready after 500 ms of the work clock',
    );
  });

  it('counts the host commands sent while counting, by name', async () => {
    clock().startCounting();
    void invoke('read_note');
    void invoke('read_note');
    void invoke('list_notes');
    expect(clock().stopCounting()).toEqual({ read_note: 2, list_notes: 1 });
  });
});
