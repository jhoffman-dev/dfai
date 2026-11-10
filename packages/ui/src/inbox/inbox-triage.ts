import {
  WAITING_STATUS,
  type Clarification,
  type GtdStatus,
  type InboxItem,
  type InboxTask,
  type VaultPath,
} from '@dfai/domain';

/**
 * What a task's row holds before Done writes it (#112): only what was picked.
 * A date picked and then emptied is '' — the row asking for it to be cleared.
 */
export interface InboxDraft {
  readonly status?: GtdStatus;
  readonly project?: VaultPath;
  readonly waitingOn?: VaultPath;
  readonly defer?: string;
  readonly due?: string;
}

/** A date the row holds, as the change to make: none when it is what the task says already. */
function dayChange(picked: string | undefined, held: string | null): string | null | undefined {
  if (picked === undefined || picked === (held ?? '')) return undefined;
  return picked === '' ? null : picked;
}

/**
 * The row's picks as one clarification — only what differs from what the task
 * says — or null when Done would change nothing.
 */
export function clarificationOf(task: InboxTask, draft: InboxDraft): Clarification | null {
  const defer = dayChange(draft.defer, task.defer);
  const due = dayChange(draft.due, task.due);
  const clarification: Clarification = {
    ...(draft.status !== undefined && draft.status !== task.status && { status: draft.status }),
    ...(draft.project !== undefined &&
      draft.project !== task.project && { project: draft.project }),
    // A person picked while the row said Waiting is not written once it no longer asks who.
    ...(asksWhoItWaitsOn(task, draft) &&
      draft.waitingOn !== undefined &&
      draft.waitingOn !== task.waitingOn && { waitingOn: draft.waitingOn }),
    ...(defer !== undefined && { defer }),
    ...(due !== undefined && { due }),
  };
  return Object.keys(clarification).length === 0 ? null : clarification;
}

/** A row's fields that link a note: what is typed in one is no link until it is picked (#823). */
export type LinkField = 'waitingOn' | 'project';

const LINK_FIELDS: readonly LinkField[] = ['waitingOn', 'project'];

/** What a row's link fields hold typed and not picked, by field. */
export type TypedLinks = Readonly<Partial<Record<LinkField, string>>>;

/** The text a row may not be written over, and the field it is typed in. */
export interface UnpickedLink {
  readonly field: LinkField;
  readonly text: string;
}

/** `was` with `field` holding `text`; null when the field holds nothing typed any more. */
export function withTyped(
  was: TypedLinks | undefined,
  field: LinkField,
  text: string | null,
): TypedLinks {
  if (text !== null) return { ...was, [field]: text };
  return Object.fromEntries(Object.entries(was ?? {}).filter(([held]) => held !== field));
}

/**
 * The first link field holding text typed and not picked, or null. A row is
 * not written over one: the text is not a note, so it is neither written nor
 * dropped behind the person's back.
 */
export function unpickedLink(typed: TypedLinks | undefined): UnpickedLink | null {
  for (const field of LINK_FIELDS) {
    const text = typed?.[field];
    if (text !== undefined) return { field, text };
  }
  return null;
}

/** What the row says when it is not written over `text`. */
export function unpickedRefusal(text: string): string {
  return `“${text}” is typed but not picked. Pick it from the list, or clear it.`;
}

/** Whether the row asks who the task waits on: it is, or is being made, Waiting. */
export function asksWhoItWaitsOn(task: InboxTask, draft: InboxDraft): boolean {
  return (draft.status ?? task.status) === WAITING_STATUS;
}

/**
 * The row focus goes to once the one at `path` is dealt with: the one after
 * it, the one before when it was last, null when it was the only one.
 */
export function rowAfter(items: readonly InboxItem[], path: VaultPath): VaultPath | null {
  const at = items.findIndex((item) => item.path === path);
  if (at === -1) return items[0]?.path ?? null;
  return (items[at + 1] ?? items[at - 1])?.path ?? null;
}

/**
 * The row focus goes to once the one at `path` has left the list — the rows
 * `before` it left, `after` — passing over any that left with it. Null for a
 * row `before` did not list.
 */
export function rowAfterLeaving(
  before: readonly InboxItem[],
  after: readonly InboxItem[],
  path: VaultPath,
): VaultPath | null {
  // One that was not listed before did not just leave: it hands nothing on.
  if (!before.some((item) => item.path === path)) return null;
  const listed = new Set(after.map((item) => item.path));
  return rowAfter(
    before.filter((item) => item.path === path || listed.has(item.path)),
    path,
  );
}
