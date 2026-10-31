import type { LocalTime } from '@dfai/domain';
import type { AutomationClock, AutomationPause } from '@dfai/application';

/** What the runner says of the vault it watches, as it is handed to the relay. */
export interface WatchedVault {
  /** The vault's root; null with none open. */
  readonly vault: string | null;
  readonly watchingSince: LocalTime | null;
  readonly pauses: ReadonlyMap<string, AutomationPause>;
}

/**
 * The automation runner's state as the local API reads it: one object for the
 * life of the app, told what the runner holds each time that changes.
 *
 * The API serves once, with deps that must stay put (`useLocalApi`), while the
 * runner (`useAutomations`) is made further down the app than the API's deps.
 * Until it is told anything, it is watching no vault.
 */
export interface AutomationRelay {
  readonly clock: AutomationClock;
  readonly point: (watched: WatchedVault) => void;
}

export function createAutomationRelay(): AutomationRelay {
  let watched: WatchedVault = { vault: null, watchingSince: null, pauses: new Map() };
  return {
    clock: {
      forVault: (vault) => {
        const { watchingSince, pauses } = watched;
        // A runner still on the vault before a switch knows nothing of this one.
        if (watched.vault !== vault || watchingSince === null) return null;
        return { watchingSince, pauses };
      },
    },
    point: (next) => {
      watched = next;
    },
  };
}
