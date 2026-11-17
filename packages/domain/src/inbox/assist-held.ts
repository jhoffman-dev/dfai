/**
 * What an Inbox item already says under the fields Inbox assist could fill
 * (#899, #903): its project or area, its due date, who it waits on. A field
 * counts as set when anything is written in it, resolved or not — a link to
 * a note since deleted, a project in plain words, "next Friday" — on any item,
 * a task or not. A plan only ever fills what is empty: a suggestion that
 * agrees with what is set adds nothing, and one that differs is a question
 * naming both.
 */

import { namesNote } from '../automations/proposal-schema.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { InboxItem } from './inbox.ts';

/** One field as it is set: what it resolves to, if anything, and how it reads. */
export interface HeldField {
  /** The note it links, or the day it reads as; null when it does not resolve. */
  readonly resolved: string | null;
  /** How it is shown in a question: as written, else as resolved. */
  readonly shown: string;
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
    projectWritten: '',
    due: item.task?.due ?? null,
    dueWritten: '',
    waitingOn: item.task?.waitingOn ?? null,
    waitingOnNames: item.task?.waitingOnNames ?? '',
  };
  return {
    project: held(written.project, written.projectWritten, noteTitle),
    due: held(written.due, written.dueWritten, (day) => day),
    waitingOn: held(written.waitingOn, written.waitingOnNames, noteTitle),
  };
}

function held<Resolved extends string>(
  resolved: Resolved | null,
  writtenAs: string,
  shownAs: (resolved: Resolved) => string,
): HeldField | null {
  const text = writtenAs.trim();
  if (resolved === null && text === '') return null;
  return { resolved, shown: resolved !== null ? shownAs(resolved) : text };
}

/** Whether a set project or area is the target suggested: the same note, or written as its name. */
export function sameProject(field: HeldField, target: VaultPath): boolean {
  return field.resolved !== null ? field.resolved === target : namesNote(field.shown, target);
}

/** Whether a set due date is the day suggested: one written that reads as no day never is. */
export function sameDay(field: HeldField, day: string): boolean {
  return field.resolved === day;
}

/** Whether the person a task waits on is the one suggested: the same note, or written as their name. */
export function samePerson(field: HeldField, target: { path: VaultPath; title: string }): boolean {
  return field.resolved !== null
    ? field.resolved === target.path
    : field.shown.toLowerCase() === target.title.toLowerCase();
}
