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
 * string, or a plain `Error` — the stubs' own, and the ones Node's file system,
 * `node:sqlite` and `execFile` throw, which the host would pass on as its `Err`.
 * Anything else is a bug: a `TypeError` in a stub, including the coded one
 * Node's argument checks throw for an argument read under the wrong name
 * (`ERR_INVALID_ARG_TYPE`), or an unstubbed command.
 */
export function isIntendedRefusal(thrown: unknown): boolean {
  if (typeof thrown === 'string') return true;
  return thrown instanceof Error && thrown.constructor === Error;
}

/** A stub's throw as the bug it records: an `Error` as it is, anything else described. */
export function stubBugOf(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  let described: string;
  try {
    described = JSON.stringify(thrown) ?? String(thrown);
  } catch {
    // A value JSON cannot hold, such as one that refers to itself: its type still says something.
    described = `${typeof thrown} JSON cannot describe`;
  }
  return new Error(`a stub threw a value that is not an Error: ${described}`);
}

export function recordStubBug(bug: Error): void {
  recorded.push(bug);
}

/** How many of the recorded bugs have been reported, by a test or the worker's end. */
let reported = 0;

/**
 * The bugs recorded since the last were reported, as one message with each
 * stack, now counted as reported. A test reports those made during it and any
 * a `beforeAll` made before it; the worker's end reports what an `afterAll` made.
 */
export function takeUnreportedStubBugs(): string | null {
  const bugs = recorded.slice(reported);
  reported = recorded.length;
  if (bugs.length === 0) return null;
  return [
    `the stub host went wrong ${bugs.length} time(s):`,
    ...bugs.map((bug) => bug.stack ?? String(bug)),
  ].join('\n\n');
}
