import { vi } from 'vitest';

/**
 * Runs `during`, catching what is thrown from microtasks meanwhile: where a
 * pane reports work it lost, thrown for nothing to catch.
 */
export async function thrownFromMicrotasks(during: () => Promise<void>): Promise<unknown[]> {
  const thrown: unknown[] = [];
  const original = globalThis.queueMicrotask;
  const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) =>
    original(() => {
      try {
        task();
      } catch (cause) {
        thrown.push(cause);
      }
    }),
  );
  try {
    await during();
  } finally {
    spy.mockRestore();
  }
  return thrown;
}
