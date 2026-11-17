/**
 * What an Inbox item already says under the fields Inbox assist could fill
 * (#899, #903): its projects or areas, its due date, who it waits on. A field
 * counts as set when anything is written in it, resolved or not — a link to
 * a note since deleted, a project in plain words, "next Friday" — on any item,
 * a task or not. A plan only ever fills what is empty: a suggestion that
 * agrees with what is set adds nothing, and one that differs is a question
 * naming both.
 */

import { namesNote } from '../automations/proposal-schema.ts';
import { indexedTexts } from '../gtd/gtd-status.ts';
import { writtenNames } from '../review/review-query.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { InboxItem } from './inbox.ts';

/** One field as it is set: what it resolves to, if anything, and each item as written. */
export interface HeldField {
  /** The note its first link resolves to, or the day it reads as; null when none does. */
  readonly resolved: string | null;
  /** Each item as written; at least one of these or `resolved`. */
  readonly written: readonly string[];
}

export interface AssistHeld {
  readonly project: HeldField | null;
  readonly due: HeldField | null;
  readonly waitingOn: HeldField | null;
}

/** What `item` has set, from what is written on it — or, for an item built without that, its task. */
export function assistHeld(item: InboxItem): AssistHeld {
  const written = item.written ?? {
    project: item.task?.project ?? null,
    projectNames: [],
    due: item.task?.due ?? null,
    dueWritten: '',
    waitingOn: item.task?.waitingOn ?? null,
    waitingOnNames: item.task?.waitingOnNames ?? '',
  };
  return {
    project: held(written.project, written.projectNames),
    due: held(written.due, [written.dueWritten]),
    waitingOn: held(written.waitingOn, [written.waitingOnNames]),
  };
}

/**
 * What an item lists under `people` (#906), from its frontmatter's value as
 * read: each one by what it shows, a link by its label; null when nothing.
 */
export function listedPeopleOf(value: unknown): HeldField | null {
  return held(null, writtenNames(indexedTexts(value).join('\u001f')));
}

function held(resolved: string | null, written: readonly string[]): HeldField | null {
  const items = written.map((each) => each.trim()).filter((each) => each !== '');
  return resolved === null && items.length === 0 ? null : { resolved, written: items };
}

/** Whether a set project or area is the target suggested: any one of them, linked or written as its name. */
export function sameProject(field: HeldField, target: VaultPath): boolean {
  return field.resolved === target || field.written.some((name) => namesNote(name, target));
}

/** Whether a set due date is the day suggested: one written that reads as no day never is. */
export function sameDay(field: HeldField, day: string): boolean {
  return field.resolved === day;
}

/** Whether the person a task waits on is the one suggested: the same note, or written as their name. */
export function samePerson(field: HeldField, target: { path: VaultPath; title: string }): boolean {
  if (field.resolved !== null) return field.resolved === target.path;
  return field.written.join(', ').toLowerCase() === target.title.toLowerCase();
}

/**
 * How a set field is named in a question, briefly: each item as written —
 * by the vault's own title where it names one of `titled` — joined "A and B",
 * or "A, B and C"; the resolved note's title or the day when nothing is written.
 */
export function heldWords(
  field: HeldField,
  titled: readonly { path: VaultPath; title: string }[] = [],
): string {
  if (field.written.length === 0) {
    const resolved = field.resolved!;
    return titled.find((target) => target.path === resolved)?.title ?? shownResolved(resolved);
  }
  const names = field.written.map(
    (name) => titled.find((target) => namesNote(name, target.path))?.title ?? name,
  );
  return names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/** A resolved value as shown: a note by its title, a day as it is. */
function shownResolved(resolved: string): string {
  return resolved.endsWith('.md') ? noteTitle(resolved as VaultPath) : resolved;
}
