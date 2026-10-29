import { claimUnsharedOf } from '@dfai/domain';
import type { AutomationsOnGitHub } from './automations-on-github.ts';
import type { AutomationsSettingsNow } from './sync-settings.ts';

/** What is known of one vault's claim: whether it waits to be pushed, and what GitHub said at the last pull. */
interface ClaimKnown {
  readonly unshared: boolean;
  /** The name GitHub's settings keep for the Mac they name: the Mac the claim was taken from. */
  readonly was: string | null;
  /** The Mac GitHub's settings named at the last pull, by id; undefined when they were not read. */
  readonly onGitHub: string | null | undefined;
}

export interface UnsharedClaims {
  /** A claim was just written here: unshared at once, as git would show it at the next pull. */
  claimed(vault: string, was: string | null): void;
  /**
   * After a completed pull: judged from git, the settings here against those
   * the fetch brought from GitHub. Says whether the claim waits to be pushed.
   */
  learn(pull: {
    vault: string;
    here: AutomationsSettingsNow;
    thisMacId: string;
    /** Whether the pull was a sync that completed, which pushed what was committed here. */
    pushed: boolean;
  }): Promise<boolean>;
  /** As the gates are asked: the settings here now, against what GitHub said at the last pull. */
  judge(vault: string, here: AutomationsSettingsNow, thisMacId: string): boolean;
  unshared(vault: string): boolean;
  was(vault: string): string | null;
  /** Whether GitHub's settings, at the last pull that read them, named this Mac. */
  namedOnGitHub(vault: string, thisMacId: string): boolean;
}

/**
 * Which vaults hold a claim of the automations written here and not on
 * GitHub (#630 attack). Kept by vault, not forgotten when another opens: a
 * claim still waits when its vault is opened again. Derived from git at
 * every completed pull, so a restart, which forgets this record, finds it
 * again at the first pull. `onGitHub` reads GitHub's settings as the last
 * fetch left them; without it only what this session wrote is known, and a
 * sync that completes is taken to have pushed it.
 */
export function createUnsharedClaims({
  onGitHub,
  onChange,
  onUnreadable,
}: {
  onGitHub: ((vault: string) => Promise<AutomationsOnGitHub>) | null;
  /** Told as a vault's claim becomes unshared or shared. */
  onChange: (vault: string) => void;
  /**
   * Told when GitHub's settings for a vault could not be read: once a vault,
   * and again only after a read of them has succeeded since.
   */
  onUnreadable: (vault: string) => void;
}): UnsharedClaims {
  const known = new Map<string, ClaimKnown>();
  const saidUnreadable = new Set<string>();
  const set = (vault: string, next: ClaimKnown) => {
    const was = known.get(vault);
    known.set(vault, next);
    if ((was?.unshared ?? false) !== next.unshared) onChange(vault);
  };
  const readGitHub = async (vault: string): Promise<AutomationsOnGitHub | undefined> => {
    if (onGitHub === null) return undefined;
    try {
      const read = await onGitHub(vault);
      saidUnreadable.delete(vault);
      return read;
    } catch {
      // Not read: the claim counts as not shared, so nothing runs on a guess; said once.
      if (!saidUnreadable.has(vault)) {
        saidUnreadable.add(vault);
        onUnreadable(vault);
      }
      return undefined;
    }
  };
  return {
    claimed: (vault, was) =>
      set(vault, { unshared: true, was, onGitHub: known.get(vault)?.onGitHub }),
    learn: async ({ vault, here, thisMacId, pushed }) => {
      if (onGitHub === null) {
        // Without git, a completed sync is what pushed it; a look pushes nothing.
        if (pushed) set(vault, { unshared: false, was: null, onGitHub: undefined });
        return known.get(vault)?.unshared ?? false;
      }
      const mine = here.automationsMac === thisMacId.trim();
      const github = mine ? await readGitHub(vault) : undefined;
      const unshared = claimUnsharedOf({
        here: here.automationsMac,
        onGitHub: github?.automationsMac,
        thisMacId,
      });
      const was = github?.automationsMacName ?? known.get(vault)?.was ?? null;
      set(vault, { unshared, was, onGitHub: github?.automationsMac });
      return unshared;
    },
    judge: (vault, here, thisMacId) => {
      const now = known.get(vault);
      if (now?.unshared === true) return true;
      if (onGitHub === null) return false;
      const unshared = claimUnsharedOf({
        here: here.automationsMac,
        onGitHub: now?.onGitHub,
        thisMacId,
      });
      if (unshared) set(vault, { unshared, was: now?.was ?? null, onGitHub: now?.onGitHub });
      return unshared;
    },
    unshared: (vault) => known.get(vault)?.unshared ?? false,
    was: (vault) => known.get(vault)?.was ?? null,
    namedOnGitHub: (vault, thisMacId) => known.get(vault)?.onGitHub === thisMacId.trim(),
  };
}
