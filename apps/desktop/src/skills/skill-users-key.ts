import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { SkillUser } from '@dfai/domain';
import type { AutomationListing } from '@dfai/application';
import type { AutomationsStore } from '../automations/automations-store.ts';

/*
 * Which rules use which skill, for the Skills page's "Used by" and its delete
 * question (#169), as one text compared by its content. The runner reads the
 * rules into new objects every minute and after every run; a text that is the
 * same for the same rules lets the page draw again only when they change.
 */

/** Parts of the key are JSON, so a rule's name may hold any character. */
type KeyPart = readonly [name: string, skill: string];

/**
 * The rules that name a skill — broken ones too, when their `skill:` reads —
 * as one text, the same for the same rules in any order. Empty for none.
 */
export function skillUsersKey(
  listing: Pick<AutomationListing, 'automations' | 'broken'> | null,
): string {
  if (listing === null) return '';
  const parts: KeyPart[] = [];
  for (const { rule } of listing.automations) {
    if (rule.action.kind === 'claude' && rule.action.skill !== undefined) {
      parts.push([rule.name, rule.action.skill]);
    }
  }
  for (const broken of listing.broken) {
    if (broken.skill !== undefined) parts.push([broken.name, broken.skill]);
  }
  if (parts.length === 0) return '';
  const sorted = parts.map((part) => JSON.stringify(part)).sort();
  return `[${sorted.join(',')}]`;
}

/** The rules a key holds, as the domain's `skillUsers` takes them. */
export function skillUsersOf(key: string): SkillUser[] {
  if (key === '') return [];
  const parts = JSON.parse(key) as KeyPart[];
  return parts.map(([name, skill]) => ({ name, action: { kind: 'claude', skill } }));
}

/** The rules that use a skill, as the runner last read them: a new array only when they change. */
export function useSkillUsers(store: AutomationsStore): readonly SkillUser[] {
  const key = useStore(store, (state) => skillUsersKey(state.automations?.listing ?? null));
  return useMemo(() => skillUsersOf(key), [key]);
}
