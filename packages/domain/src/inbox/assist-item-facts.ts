/**
 * What each item Inbox assist asks about holds of its own (#906, #907), from
 * its file as read on the press and the vault's open tasks: the tasks it may
 * copy, the other Inbox items it may be a second capture of, the addresses
 * and words it gives, and what it lists under `people`.
 */

import {
  possibleDuplicateTasks,
  titleLikeness,
  type TaskCandidate,
} from '../gtd/task-similarity.ts';
import { splitFrontmatter } from '../markdown/markdown-document.ts';
import { addressesIn } from '../people/person-match.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { HeldField } from './assist-held.ts';
import type { AssistItemFacts } from './assist-plan.ts';
import { isInInbox, type InboxItem } from './inbox.ts';

/** One item asked about, as read on the press. */
export interface AssistAsked {
  readonly item: InboxItem;
  /** Its file's text. */
  readonly text: string;
  /** When its file last changed, in milliseconds: which of two captures is the newer. */
  readonly modified: number;
  /** What it lists under `people`, read from its frontmatter; null when nothing. */
  readonly listedPeople: HeldField | null;
  /** Every property written in its frontmatter, by lower-case key. */
  readonly written: ReadonlyMap<string, readonly string[]>;
}

/**
 * Each asked item's own facts. Its possible duplicates are open tasks that
 * are not Inbox items themselves — not under `Inbox/`, not at the Inbox
 * status, not among those asked — so two captures are never each other's
 * kept copy. Two asked items whose titles match are a question on the newer
 * (its file changed later); on both when that cannot be told.
 */
export function assistItemFacts({
  asked,
  tasks,
}: {
  asked: readonly AssistAsked[];
  tasks: readonly TaskCandidate[];
}): Map<VaultPath, AssistItemFacts> {
  const askedPaths = new Set<string>(asked.map((each) => each.item.path));
  const kept = tasks.filter((task) => !isInInbox(task.path) && !askedPaths.has(task.path));
  return new Map(
    asked.map((each) => {
      const project = projectOf(each.item);
      const body = splitFrontmatter(each.text).body;
      const facts: AssistItemFacts = {
        duplicates: possibleDuplicateTasks({ item: { ...each.item, project }, tasks: kept }),
        inboxTwin: inboxTwinOf(each, asked),
        addresses: addressesIn(body),
        listedPeople: each.listedPeople,
        written: each.written,
        text: `${each.item.title}\n${body}`,
        hasBody: body.trim() !== '',
      };
      return [each.item.path, facts];
    }),
  );
}

const projectOf = (item: InboxItem): VaultPath | null =>
  item.task?.project ?? item.written?.project ?? null;

/** The title of another asked item this one is the newer capture of, or cannot be told from; null for none. */
function inboxTwinOf(one: AssistAsked, asked: readonly AssistAsked[]): string | null {
  const twin = asked.find((other) => {
    if (other.item.path === one.item.path) return false;
    const likeness = titleLikeness(one.item.title, other.item.title);
    if (likeness !== 'same-title' && likeness !== 'same-words') return false;
    const [mine, theirs] = [projectOf(one.item), projectOf(other.item)];
    if (mine !== null && theirs !== null && mine !== theirs) return false;
    return !(one.modified < other.modified);
  });
  return twin?.item.title ?? null;
}
