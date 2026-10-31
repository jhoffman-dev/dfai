import { GTD_STATUSES, type GtdStatus } from '../gtd/gtd-status.ts';

/**
 * What one key does to the Inbox row that has the focus (#109, #307 Q11):
 * a status is written alone, at once — the project stays whatever it was —
 * or a picker is opened, whose pick is written as soon as it is made. Done
 * is GTD's finished status, `archive` (ADR-0029).
 */
export type TriageAction =
  | { readonly kind: 'status'; readonly status: GtdStatus }
  | { readonly kind: 'pick'; readonly field: 'project' | 'defer' };

export interface TriageKey {
  /** The letter, lower-cased. */
  readonly key: string;
  readonly action: TriageAction;
}

/**
 * The keys, in the order a row shows them. Longterm, Backlog and In Progress
 * have no key: they are rare from the Inbox, and the row's status picker
 * still offers them.
 */
export const TRIAGE_KEYS: readonly TriageKey[] = [
  { key: 'n', action: { kind: 'status', status: 'next-action' } },
  { key: 'w', action: { kind: 'status', status: 'waiting' } },
  { key: 's', action: { kind: 'status', status: 'someday' } },
  { key: 't', action: { kind: 'pick', field: 'defer' } },
  { key: 'p', action: { kind: 'pick', field: 'project' } },
  { key: 'd', action: { kind: 'status', status: 'archive' } },
];

/**
 * Keys that stand for another (#109): X ticks done, as it does on Today, so
 * the one finishing key works on both pages. A row shows only the key it
 * stands for.
 */
const TRIAGE_KEY_ALIASES: Readonly<Record<string, string>> = { x: 'd' };

/** Every key that does what a listed key does: the key, then any that stand for it. */
export function triageKeysOf(key: string): readonly string[] {
  const aliases = Object.keys(TRIAGE_KEY_ALIASES).filter(
    (alias) => TRIAGE_KEY_ALIASES[alias] === key,
  );
  return [key, ...aliases];
}

/**
 * The action a key stands for, or null when it is not a triage key — or
 * writes a status the vault's Task type does not declare (`statuses`): a
 * vault still on statuses of its own is never given one it lacks (#112).
 */
export function triageActionOf(
  key: string,
  statuses: readonly GtdStatus[] = GTD_STATUSES,
): TriageAction | null {
  const lower = key.toLowerCase();
  const letter = TRIAGE_KEY_ALIASES[lower] ?? lower;
  const found = TRIAGE_KEYS.find((each) => each.key === letter);
  if (found === undefined) return null;
  if (found.action.kind === 'status' && !statuses.includes(found.action.status)) return null;
  return found.action;
}
