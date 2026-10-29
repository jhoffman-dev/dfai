import type { GraphScope } from '../graph/graph-scope.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  HISTORY_LIMIT,
  type NavigationHistory,
  type NavigationPlace,
} from './navigation-history.ts';
import { MAX_PANES, type Pane, type Tab, type Workspace } from './workspace.ts';

/**
 * The workspace as it goes into storage and comes back (tab-model.md §2).
 *
 * Versioned, so a later shape can tell this one apart; it holds places only,
 * each validated on read, since storage is hand-editable and a stale or
 * malformed entry should cost one tab rather than the window. A place has no
 * field a secret could sit in (ADR-0017), so nothing here needs scrubbing.
 *
 * Ids are unique within a session and within one stored record, no further:
 * `nextId` is stored so a save then a restore never hands out an id again,
 * and an id that is not `t<n>` with a safe `n` — hand-edited, or past what a
 * number can count — is minted afresh on read rather than trusted.
 */
export const WORKSPACE_FORMAT_VERSION = 1;

export interface RememberedWorkspace {
  readonly version: typeof WORKSPACE_FORMAT_VERSION;
  readonly vault: string;
  readonly focused: number;
  readonly nextId: number;
  readonly panes: readonly {
    readonly active: string;
    readonly tabs: readonly {
      readonly id: string;
      readonly pinned: boolean;
      readonly history: NavigationHistory;
    }[];
  }[];
}

/** The workspace as it goes into storage, against the vault it belongs to. */
export function rememberWorkspace({
  workspace,
  vaultKey,
}: {
  workspace: Workspace;
  vaultKey: string;
}): RememberedWorkspace {
  return {
    version: WORKSPACE_FORMAT_VERSION,
    vault: vaultKey,
    focused: workspace.focused,
    nextId: workspace.nextId,
    panes: workspace.panes.map((pane) => ({
      active: pane.active,
      tabs: pane.tabs.map(({ id, pinned, history }) => ({ id, pinned, history })),
    })),
  };
}

/**
 * The workspace remembered for a vault, out of whatever was stored.
 *
 * Only for the vault it was remembered against: the paths are relative to a
 * vault, and restoring one vault's tabs into another would open them on notes
 * that are not there. The unversioned `{ vault, paths, focused }` the split
 * was stored as before tabs upgrades to one tab per pane. Anything else
 * unrecognised reads as nothing remembered, and a bad tab or pane is dropped,
 * because the layout is a convenience and a stale one should cost a tab
 * rather than an error.
 */
export function parseRememberedWorkspace(remembered: unknown, vaultKey: string): Workspace | null {
  if (!isRecord(remembered) || remembered.vault !== vaultKey) return null;
  if (!('version' in remembered)) return upgradeSplit(remembered, vaultKey);
  if (remembered.version !== WORKSPACE_FORMAT_VERSION || !Array.isArray(remembered.panes)) {
    return null;
  }
  const seen = new Set<string>();
  const read = remembered.panes
    .map((pane) => readPane(pane, seen))
    .filter((pane): pane is Pane => pane !== null)
    .slice(0, MAX_PANES);
  if (read.length === 0) return null;
  const { panes, nextId } = remintIds(read, readNextId(remembered.nextId));
  const focused = remembered.focused;
  return {
    panes,
    focused:
      typeof focused === 'number' &&
      Number.isInteger(focused) &&
      focused >= 0 &&
      focused < panes.length
        ? focused
        : 0,
    nextId,
    closed: [],
  };
}

/** The stored `nextId`, or 1 when there is none worth trusting. */
function readNextId(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/** The old split, as one tab per pane on the note the pane held. */
function upgradeSplit(remembered: unknown, vaultKey: string): Workspace | null {
  const layout = parseRememberedSplit(remembered, vaultKey);
  if (layout === null) return null;
  const panes = layout.paths.map((path, index): Pane => {
    const id = `t${index + 1}`;
    const current: NavigationPlace | null = path === null ? null : { kind: 'note', path };
    return {
      tabs: [{ id, pinned: false, history: { back: [], current, forward: [] } }],
      active: id,
    };
  });
  return { panes, focused: layout.focused, nextId: panes.length + 1, closed: [] };
}

/**
 * Ids the session can count past. `t<n>` with a safe `n` moves `nextId` past
 * it; `t<n>` with an `n` past what a number counts is minted afresh, with the
 * pane's `active` following it, since nothing could ever count past it. Any
 * other id is kept: it is not of this module's making and can never be
 * mistaken for an id it mints.
 */
function remintIds(panes: readonly Pane[], stored: number): { panes: Pane[]; nextId: number } {
  let nextId = stored;
  for (const pane of panes) {
    for (const tab of pane.tabs) {
      const n = countedId(tab.id);
      if (n !== null) nextId = Math.max(nextId, n + 1);
    }
  }
  const minted = new Map<string, string>();
  for (const pane of panes) {
    for (const tab of pane.tabs) {
      if (!isUncountable(tab.id)) continue;
      minted.set(tab.id, `t${nextId}`);
      nextId += 1;
    }
  }
  if (minted.size === 0) return { panes: [...panes], nextId };
  return {
    panes: panes.map((pane) => ({
      active: minted.get(pane.active) ?? pane.active,
      tabs: pane.tabs.map((tab) => ({ ...tab, id: minted.get(tab.id) ?? tab.id })),
    })),
    nextId,
  };
}

const COUNTED_ID = /^t(\d+)$/;

/** The `n` of a `t<n>` id the session can count past, or null for any other id. */
function countedId(id: string): number | null {
  const match = COUNTED_ID.exec(id);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && Number.isSafeInteger(n + 1) ? n : null;
}

/** A `t<n>` id whose `n` is past what a number counts, so nothing could ever pass it. */
function isUncountable(id: string): boolean {
  return COUNTED_ID.test(id) && countedId(id) === null;
}

function readPane(value: unknown, seen: Set<string>): Pane | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const read = value.tabs
    .map((tab) => readTab(tab, seen))
    .filter((tab): tab is Tab => tab !== null);
  if (read.length === 0) return null;
  const tabs = [...read.filter((tab) => tab.pinned), ...read.filter((tab) => !tab.pinned)];
  const active = tabs.some((tab) => tab.id === value.active)
    ? (value.active as string)
    : (tabs[0] as Tab).id;
  return { tabs, active };
}

function readTab(value: unknown, seen: Set<string>): Tab | null {
  if (!isRecord(value)) return null;
  const { id, pinned, history } = value;
  if (typeof id !== 'string' || id === '' || seen.has(id) || !isRecord(history)) return null;
  seen.add(id);
  return { id, pinned: pinned === true, history: readHistory(history) };
}

function readHistory(value: Record<string, unknown>): NavigationHistory {
  const places = (held: unknown) =>
    Array.isArray(held)
      ? held.map(readPlace).filter((place): place is NavigationPlace => place !== null)
      : [];
  return {
    back: places(value.back).slice(-HISTORY_LIMIT),
    current: readPlace(value.current),
    forward: places(value.forward).slice(0, HISTORY_LIMIT),
  };
}

/** A place that came back from storage, rebuilt field by field, or null if it is not one. */
function readPlace(value: unknown): NavigationPlace | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'note':
    case 'document': {
      const path = readPath(value.path);
      return path === null ? null : { kind: value.kind, path };
    }
    case 'type':
      return typeof value.name === 'string' && value.name !== ''
        ? { kind: 'type', name: value.name }
        : null;
    case 'graph': {
      const scope = readScope(value.scope);
      return scope === null ? null : { kind: 'graph', scope };
    }
    case 'tags':
      return typeof value.tag === 'string' || value.tag === null
        ? { kind: 'tags', tag: value.tag }
        : null;
    case 'query':
    case 'archive':
    case 'inbox':
    case 'review':
    case 'today':
    case 'automations':
    case 'activity':
    case 'templates':
    case 'terms':
    case 'skills':
    case 'library':
    case 'highlights':
    case 'ask':
      return { kind: value.kind };
    default:
      return null;
  }
}

function readScope(value: unknown): GraphScope | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'vault') return { kind: 'vault' };
  if (value.kind !== 'note' || (value.depth !== 1 && value.depth !== 2)) return null;
  const path = readPath(value.path);
  return path === null ? null : { kind: 'note', path, depth: value.depth };
}

function readPath(value: unknown): VaultPath | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return createVaultPath(value);
  } catch {
    // A hand-edited or stale path that no longer parses costs the place it
    // sat in, which is what a deleted note costs anyway.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The split the app remembered before it had tabs (`atlas.panes`): the
 * note each pane held, and which pane was focused. Only for the vault it was
 * remembered against, since the paths are relative to one; anything
 * unrecognised reads as nothing remembered, because a stale split should
 * cost a single pane rather than an error.
 */
function parseRememberedSplit(
  remembered: unknown,
  vaultKey: string,
): { paths: readonly (VaultPath | null)[]; focused: number } | null {
  if (typeof remembered !== 'object' || remembered === null) return null;
  const record = remembered as { vault?: unknown; paths?: unknown; focused?: unknown };
  if (record.vault !== vaultKey) return null;
  if (!Array.isArray(record.paths) || record.paths.length === 0) return null;

  // `Array.from` rather than `map`, which preserves a hole: a hole is neither a
  // path nor null, so `focused` could name a pane that is not there, and every
  // later open would be skipped by the same hole rather than shown.
  const paths = Array.from(record.paths.slice(0, MAX_PANES), readSplitPath);
  const focused = typeof record.focused === 'number' ? record.focused : 0;
  return {
    paths,
    focused: Number.isInteger(focused) && focused >= 0 && focused < paths.length ? focused : 0,
  };
}

function readSplitPath(value: unknown): VaultPath | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return createVaultPath(value);
  } catch {
    // A hand-edited or stale path that no longer parses costs an empty pane,
    // which is what a first run shows anyway.
    return null;
  }
}
