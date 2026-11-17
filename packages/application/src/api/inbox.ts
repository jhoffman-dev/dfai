import {
  createVaultPath,
  INBOX_LIST_LIMIT,
  InvalidVaultPathError,
  type InboxItem,
  type VaultPath,
} from '@dfai/domain';
import { listVaultInbox } from '../inbox/list-inbox.ts';
import { FilingRefusedError, processInboxItems } from '../inbox/process-inbox.ts';
import { ApiError } from './api-error.ts';
import type { ApiArchiveOutcome, ApiInboxItem } from './contract.ts';
import { moveBatch } from './archive.ts';
import { decodeInboxCursor, encodeInboxCursor } from './cursor.ts';
import { bodyObject, countOf, requiredString } from './fields.ts';
import { isApiNotePath } from './paths.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * The notes waiting in the Inbox to be filed, as its page lists them (P30-01):
 * newest first, each with what the meeting import made of it, a page at a
 * time with how many wait in all (#167). Each page is read on from the
 * cursor the one before handed out, so filing what a page listed loses
 * nothing. Notes of the proposal type are not among them — they are answered
 * through the proposals routes, never filed. Reads the index and writes nothing.
 */
export async function inboxRoute(request: VaultRequest): Promise<RouteResult> {
  const limit = countOf(request.query['limit'], {
    field: 'limit',
    fallback: INBOX_LIST_LIMIT,
    max: INBOX_LIST_LIMIT,
  });
  const cursor = request.query['cursor'];
  const after = cursor === undefined ? null : decodeInboxCursor(cursor);
  const { items, truncated, total, last } = await listVaultInbox({
    ...request,
    page: { limit, after },
  });
  const next = truncated && last !== null ? encodeInboxCursor(last) : null;
  return { status: 200, body: { items: items.map(apiInboxItem), truncated, next, total } };
}

/**
 * An item as the contract answers it, field by field: the Inbox's own item
 * carries more (what Inbox assist reads, #903), and a field reaches the API
 * only when the contract names it.
 */
function apiInboxItem(item: InboxItem): ApiInboxItem {
  const { task } = item;
  return {
    path: item.path,
    title: item.title,
    type: item.type,
    arrivedIn: item.arrivedIn,
    importOutcome: item.importOutcome,
    importError: item.importError,
    task:
      task === null
        ? null
        : {
            status: task.status,
            project: task.project,
            waitingOn: task.waitingOn,
            waitingOnNames: task.waitingOnNames,
            defer: task.defer,
            due: task.due,
          },
  };
}

/**
 * Files notes from the Inbox under a project or an area, as the Inbox's
 * Process does (P30-01): each gets `project: [[…]]` linking it (#214). A
 * note in the `Inbox` folder moves to its type's home folder for its day; a
 * meeting waiting in its month's folder stays where it is, and is answered
 * among `linked`. `project` must be a project or an area; any other note
 * refuses the whole request before a note moves.
 */
export async function processInboxRoute(request: VaultRequest): Promise<RouteResult> {
  const project = projectOf(request.body);
  const today = request.clock.today();
  let linked: readonly VaultPath[] = [];
  try {
    const answer = await moveBatch(request, async (batch) => {
      const outcome = await processInboxItems({ ...batch, project, today });
      linked = outcome.linked;
      return outcome;
    });
    return { ...answer, body: { ...(answer.body as ApiArchiveOutcome), linked } };
  } catch (error) {
    if (error instanceof FilingRefusedError) throw new ApiError('invalid', error.message);
    throw error;
  }
}

function projectOf(body: unknown): VaultPath {
  const raw = requiredString(bodyObject(body), 'project');
  let path: VaultPath;
  try {
    path = createVaultPath(raw);
  } catch (error) {
    if (error instanceof InvalidVaultPathError) {
      throw new ApiError('invalid', 'project must be a vault path');
    }
    throw error;
  }
  if (!isApiNotePath(path)) {
    throw new ApiError(
      'invalid',
      'project must be a note: a .md file outside .atlas and hidden folders',
    );
  }
  return path;
}
