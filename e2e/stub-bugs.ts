/**
 * What went wrong in this worker's stub host rather than in the app: a command
 * nobody stubbed, or a stub that crashed. The page sees only a refusal, which a
 * spec expecting "some refusal shows" would pass on, so the `test` in
 * fixtures.ts fails any test during which one was recorded, with its stack.
 * A worker runs one test at a time, so what is recorded during a test is its own.
 */
const recorded: Error[] = [];

/**
 * A command the stub host has no answer for. Thrown in place of the refusal a
 * real `Err` would be, so it is recorded as a bug in the stub, not a refusal.
 */
export class UnstubbedCommandError extends Error {
  constructor(command: string) {
    super(`unexpected command ${command}: the stub host has no answer for it`);
    this.name = 'UnstubbedCommandError';
  }
}

/**
 * Whether a stub's throw is a refusal it meant, as a command's `Err` is: a
 * string, a plain `Error`, or a Node file error passed on as the host would.
 * Anything else — a `TypeError` in a stub, an unstubbed command — is a bug.
 */
export function isIntendedRefusal(thrown: unknown): boolean {
  if (typeof thrown === 'string') return true;
  if (!(thrown instanceof Error)) return false;
  if (thrown.constructor === Error) return true;
  return typeof (thrown as { code?: unknown }).code === 'string';
}

export function recordStubBug(bug: Error): void {
  recorded.push(bug);
}

/** How many bugs this worker has recorded, to tell a test's own from those before it. */
export function stubBugsRecorded(): number {
  return recorded.length;
}

/** The bugs recorded since `mark`, as one message with each stack. */
export function stubBugsSince(mark: number): string | null {
  const bugs = recorded.slice(mark);
  if (bugs.length === 0) return null;
  return [
    `the stub host went wrong ${bugs.length} time(s):`,
    ...bugs.map((bug) => bug.stack ?? String(bug)),
  ].join('\n\n');
}
