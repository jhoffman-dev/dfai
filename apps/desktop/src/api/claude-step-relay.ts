import type { ClaudeStepPorts } from '@dfai/application';

/**
 * The Claude step's ports for the API (P32-05), which is built before they
 * are — they reach Claude through the toolboxes the API's own deps make (the
 * shape of `createOwnerNameRelay`): the app points it at them once they are
 * built, and `POST /v1/assistant/propose-tasks` reads them as it arrives.
 */
export interface ClaudeStepRelay {
  /** The ports now; null until the app has built them. */
  readonly ports: () => ClaudeStepPorts | null;
  readonly point: (ports: ClaudeStepPorts | null) => void;
}

export function createClaudeStepRelay(): ClaudeStepRelay {
  let current: ClaudeStepPorts | null = null;
  return {
    ports: () => current,
    point: (next) => {
      current = next;
    },
  };
}
