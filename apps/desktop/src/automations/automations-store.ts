import { createStore, useStore, type StoreApi } from 'zustand';
import { shallow } from 'zustand/shallow';
import { ownerNeededBy, type OwnerSettings } from '@dfai/domain';
import type { useAutomations } from './use-automations.ts';

/** The vault's automations as their runner holds them: the rules read, and the commands on them. */
export type AutomationsController = ReturnType<typeof useAutomations>;

/**
 * Where the open vault's automations stand, as their runner
 * (`AutomationsRunner`) last said (#326). The runner holds the rules and runs
 * them; the Automations page and the window read them from here, so a rule
 * read again or run draws the page and not the whole window.
 */
export interface AutomationsState {
  /** Null until the runner has drawn once. */
  readonly automations: AutomationsController | null;
}

export type AutomationsStore = StoreApi<AutomationsState>;

export function createAutomationsStore(): AutomationsStore {
  return createStore<AutomationsState>()(() => ({ automations: null }));
}

/**
 * Says where the rules stand, as the runner draws them: a draw whose every
 * part is as it was says nothing, so the page is not drawn for it.
 */
export function publishAutomations(
  store: AutomationsStore,
  automations: AutomationsController | null,
): void {
  store.setState((was) => (shallow(was.automations, automations) ? was : { automations }));
}

/** The runner and its commands, for the Automations page. */
export function useAutomationsController(store: AutomationsStore): AutomationsController | null {
  return useStore(store, (state) => state.automations);
}

/**
 * Whether a rule read needs the owner's name or addresses, which the vault
 * does not give (`ownerNeededBy`), for the Inbox to say so: a yes or no, so
 * the window is drawn only when the answer changes, not each time the rules
 * are read. Null `owner` while the settings have not answered: nothing to say yet.
 */
export function useOwnerNeeded(
  store: AutomationsStore,
  owner: Omit<OwnerSettings, 'people'> | null,
): boolean {
  return useStore(store, (state) => {
    const listing = state.automations?.listing ?? null;
    if (owner === null || listing === null) return false;
    const rules = listing.automations.map(({ rule }) => rule);
    return ownerNeededBy(rules, { ...owner, people: [] });
  });
}
