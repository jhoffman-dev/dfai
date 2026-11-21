import {
  compileInboxCountQuery,
  compileInboxQuery,
  createVaultPath,
  inboxItem,
  inboxKeyOf,
  INBOX_LIST_LIMIT,
  tasksStartInInbox,
  type InboxItem,
  type InboxKey,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/** The Inbox's notes, and whether there were more than it lists. */
export interface InboxListing {
  readonly items: readonly InboxItem[];
  /** More wait after these. */
  readonly truncated: boolean;
  /** How many wait in all, listed or not (#167). */
  readonly total: number;
  /** Where the last note listed stands, to read on from it (#167); null when none is listed. */
  readonly last: InboxKey | null;
}

/** How a page is asked for: which notes wait, and the vault's rule for tasks. */
interface InboxReading {
  index: Pick<IndexPort, 'query'>;
  /**
   * Whether the vault's tasks start in the Inbox (`tasksStartInInbox` of its
   * types): then a task given another status has left the list (#112).
   */
  tasksStartInInbox?: boolean;
  /**
   * Whether the vault's tasks are ranked 1 to 4 (`ranksTasks` of its types,
   * #913): then each task carries its priority; otherwise it carries none.
   */
  ranksTasks?: boolean;
}

/**
 * Everything waiting in the one Inbox, newest first, read from the index: every
 * note in the `Inbox` folder — of any type or none, at any depth: a captured
 * task, an imported meeting, a note dropped in by hand (P30-01) — and every
 * task whose status is Inbox wherever it lives (#112). A page at a time, read
 * on from the last note of the page before (`after`), never by position, and
 * saying how many wait in all, so a limit never hides work (#167).
 */
export async function listInbox({
  index,
  limit = INBOX_LIST_LIMIT,
  after = null,
  tasksStartInInbox = false,
  ranksTasks = false,
}: InboxReading & {
  limit?: number;
  /** The last note of the page before; the first page when null. */
  after?: InboxKey | null;
}): Promise<InboxListing> {
  const page = await readPage({
    index,
    limit,
    after,
    through: null,
    tasksStartInInbox,
    ranksTasks,
  });
  // A first page that holds them all has counted them; any other page asks.
  const total =
    page.more || after !== null ? await countInbox(index, tasksStartInInbox) : page.items.length;
  return { items: page.items, truncated: page.more, total, last: page.last };
}

/**
 * Every note that waits, up to and including `through`, in the Inbox's
 * order: what the page shows once more than its first page was asked for,
 * read again — a page at a time, each read on from the last, so no read is
 * ever larger than a page, however many have been shown (#167).
 */
export async function listInboxThrough({
  index,
  through,
  tasksStartInInbox = false,
  ranksTasks = false,
}: InboxReading & { through: InboxKey }): Promise<InboxListing> {
  const items: InboxItem[] = [];
  // `through` itself may have been filed since: the last listed is the last read.
  let last: InboxKey | null = null;
  for (;;) {
    const page = await readPage({
      index,
      limit: INBOX_LIST_LIMIT,
      after: last,
      through,
      tasksStartInInbox,
      ranksTasks,
    });
    items.push(...page.items);
    last = page.last ?? last;
    if (!page.more) break;
  }
  const total = await countInbox(index, tasksStartInInbox);
  return { items, truncated: total > items.length, total, last };
}

/** One page of the Inbox, at most `limit` long, its last note's key, and whether more follow it. */
async function readPage({
  index,
  limit,
  after,
  through,
  tasksStartInInbox,
  ranksTasks,
}: Required<InboxReading> & {
  limit: number;
  after: InboxKey | null;
  through: InboxKey | null;
}): Promise<{ items: InboxItem[]; last: InboxKey | null; more: boolean }> {
  // One more than is shown, so a full page is told apart from a cut-off one.
  const { sql, parameters } = compileInboxQuery({
    limit: limit + 1,
    after,
    through,
    tasksStartInInbox,
  });
  const result = await index.query(sql, parameters);
  const cell = (row: readonly unknown[], name: string) => row[result.columns.indexOf(name)];
  const rows = result.rows.slice(0, limit).map((row) => {
    const path = createVaultPath(String(cell(row, 'path')));
    const item = inboxItem({
      path,
      title: String(cell(row, 'title') ?? ''),
      type: cell(row, 'type'),
      importStamped: Boolean(cell(row, 'importStamped')),
      importDeclared: Boolean(cell(row, 'importDeclared')),
      importOutcome: cell(row, 'importOutcome'),
      importError: cell(row, 'importError'),
      status: cell(row, 'status'),
      project: cell(row, 'project'),
      waitingOn: cell(row, 'waitingOn'),
      waitingOnNames: cell(row, 'waitingOnNames'),
      defer: cell(row, 'defer'),
      due: cell(row, 'due'),
      projectWritten: cell(row, 'projectWritten'),
      dueWritten: cell(row, 'dueWritten'),
      ...(ranksTasks && { priority: cell(row, 'priority') }),
    });
    return { item, key: inboxKeyOf({ path, modified: cell(row, 'modified') }) };
  });
  return {
    items: rows.map((row) => row.item),
    last: rows.at(-1)?.key ?? null,
    more: result.truncated || result.rows.length > limit,
  };
}

/** How many notes wait in the Inbox, counted as {@link listInbox} lists them. */
export async function countInbox(
  index: Pick<IndexPort, 'query'>,
  tasksStartInInbox: boolean,
): Promise<number> {
  const { sql, parameters } = compileInboxCountQuery({ tasksStartInInbox });
  const result = await index.query(sql, parameters);
  return Number(result.rows[0]?.[result.columns.indexOf('total')] ?? 0);
}

/**
 * {@link listInbox} for a caller that does not hold the vault's types — the
 * weekly review, the API: they are read first, so it lists, and counts, what
 * the Inbox page does.
 */
export async function listVaultInbox({
  index,
  fs,
  markdown,
  page = {},
}: {
  index: Pick<IndexPort, 'query'>;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  /** Which page: how many, after which note. The first {@link INBOX_LIST_LIMIT} unless said. */
  page?: { readonly limit?: number; readonly after?: InboxKey | null };
}): Promise<InboxListing> {
  const types = await loadObjectTypes({ fs, markdown });
  return listInbox({ index, ...page, tasksStartInInbox: tasksStartInInbox(types) });
}
