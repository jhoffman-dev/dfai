import {
  assistItemFacts,
  assistTaskCandidate,
  compileAssistTasksQuery,
  compileTitledNotesQuery,
  createVaultPath,
  FILED_UNDER_TYPES,
  filingRefusal,
  listedPeopleOf,
  MEETING_PEOPLE_KEY,
  PERSON_TYPE,
  splitFrontmatter,
  takenTitles,
  waitingOnRefusal,
  writtenPropertiesOf,
  type AssistFacts,
  type AssistReadProperties,
  type AssistTarget,
  type InboxItem,
  type TaskCandidate,
  type VaultPath,
} from '@dfai/domain';
import { notesInUseOfTypes } from '../archive/notes-in-use.ts';
import type { IndexPort } from '../index/ports.ts';
import { loadLinkDirectory } from '../meeting-links/link-directory.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock } from '../ports.ts';
import { rowsOf } from '../review/review-reads.ts';

/** What Inbox assist reads the vault through, for a preview and for applying a row alike. */
export interface AssistReadPorts {
  readonly clock: Pick<Clock, 'today'>;
  readonly markdown: MarkdownPort;
  readonly index: Pick<IndexPort, 'notesOfType' | 'query'>;
}

/** An item's note as read: its text, and when it last changed. */
export interface AssistReadNote {
  readonly path: VaultPath;
  readonly text: string;
  readonly modified: number;
}

/** The vault as Inbox assist checks an answer against it, and the open tasks behind it. */
export interface AssistVaultRead {
  readonly facts: AssistFacts;
  readonly tasks: readonly TaskCandidate[];
  /** True when the open tasks could not be read whole: a duplicate may have been missed. */
  readonly cut: boolean;
}

/**
 * What an answer is checked against, read on the press and never on opening
 * the Inbox: the projects, areas and people clarifying offers, everyone in
 * People with their addresses and aliases, the open tasks an item may copy,
 * and what each asked item holds of its own. Four reads of the index, all at once.
 */
export async function readAssistVault(
  ports: AssistReadPorts,
  asked: { notes: readonly AssistReadNote[]; items: readonly InboxItem[] },
): Promise<AssistVaultRead> {
  const [projects, people, tasks, directory] = await Promise.all([
    notesInUseOfTypes({ index: ports.index, types: FILED_UNDER_TYPES }),
    notesInUseOfTypes({ index: ports.index, types: [PERSON_TYPE] }),
    rowsOf(ports.index, compileAssistTasksQuery()),
    loadLinkDirectory({ index: ports.index }),
  ]);
  const target = (note: { path: string; title: string }): AssistTarget => ({
    path: createVaultPath(note.path),
    title: note.title,
  });
  const byPath = new Map(asked.items.map((item) => [item.path, item]));
  const candidates = tasks.rows.map(assistTaskCandidate);
  const facts: AssistFacts = {
    today: ports.clock.today(),
    filingTargets: projects
      .filter(
        (note) => filingRefusal({ path: createVaultPath(note.path), type: note.type }) === null,
      )
      .map(target),
    people: people
      .filter(
        (note) => waitingOnRefusal({ path: createVaultPath(note.path), type: note.type }) === null,
      )
      .map(target),
    directory: directory.people,
    takenTitles: new Set(),
    items: assistItemFacts({
      asked: asked.notes.flatMap((note) => {
        const item = byPath.get(note.path);
        if (item === undefined) return [];
        return [{ item, ...note, ...previewPropertiesOf(ports.markdown, note.text) }];
      }),
      tasks: candidates,
    }),
  };
  return { facts, tasks: candidates, cut: tasks.truncated };
}

/**
 * Which of `names` a note of any type has as its title, folded: one bounded
 * read, and none for no names. A read cut short counts every name as taken.
 */
export async function titlesTaken(
  ports: Pick<AssistReadPorts, 'index'>,
  names: readonly string[],
): Promise<ReadonlySet<string>> {
  if (names.length === 0) return new Set();
  const { rows, truncated } = await rowsOf(ports.index, compileTitledNotesQuery(names));
  const titles = rows.map((row) => String(row['title'] ?? ''));
  return takenTitles(names, titles, { cut: truncated });
}

/**
 * What the item has written in its frontmatter, and lists under `people`, as
 * the preview reads it. A block that cannot be read holds something unknown:
 * its people are never written over, and a copy of it is never planned silently.
 */
function previewPropertiesOf(markdown: MarkdownPort, text: string) {
  const read = assistPropertiesOf(markdown, text);
  if (read !== null) return read;
  const unread = ['what could not be read'];
  return {
    listedPeople: { resolved: null, written: unread },
    written: new Map([['frontmatter', unread]]),
  };
}

/** A note's frontmatter as Inbox assist reads it; null when its block cannot be read. */
export function assistPropertiesOf(markdown: MarkdownPort, text: string): AssistReadProperties {
  const { frontmatter } = splitFrontmatter(text);
  if (markdown.frontmatterProblem(frontmatter) !== null) return null;
  const properties = markdown.frontmatterProperties(frontmatter);
  return {
    listedPeople: listedPeopleOf(properties[MEETING_PEOPLE_KEY]),
    written: writtenPropertiesOf(properties),
  };
}
