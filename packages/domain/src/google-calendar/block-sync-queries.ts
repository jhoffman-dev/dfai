import type { CompiledQuery } from '../query/view-query.ts';
import { BLOCK_KEYS, BLOCK_TYPE } from '../timeblocks/block-type.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import { BLOCK_SYNC_KEYS } from './block-sync.ts';

const marks = (count: number) => Array.from({ length: count }, () => '?').join(', ');

/**
 * The blocks a sync may write to: every block starting on or after
 * `fromDay`, which may need pushing, and any block, however old, whose
 * event Google listed. Ids come in lists of at most `EVENT_ID_LOOKUP_SIZE`.
 * Column: path.
 */
export function compileBlocksToSyncQuery({
  ids,
  fromDay,
}: {
  ids: readonly string[];
  fromDay: string;
}): CompiledQuery {
  return {
    sql: `/* blocks: to sync */ SELECT DISTINCT kind.path AS "path" FROM props AS kind
 WHERE kind.key = 'type' AND lower(trim(kind.value_text)) = ? AND ${userSpaceNoteSql('kind.path')}
   AND (kind.path IN (SELECT path FROM props WHERE key = ? AND substr(value_text, 1, 10) >= ?)
        OR kind.path IN (SELECT path FROM props WHERE key = ? AND value_text IN (${marks(ids.length)})))
 ORDER BY kind.path`,
    parameters: [BLOCK_TYPE, BLOCK_KEYS.start, fromDay, BLOCK_SYNC_KEYS.eventId, ...ids],
  };
}
