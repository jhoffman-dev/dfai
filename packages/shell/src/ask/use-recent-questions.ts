import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CHATS_FOLDER, type VaultPath } from '@dfai/domain';
import { recentQuestions, type ChatSummary, type VaultFsPort } from '@dfai/application';
import type { AskRecent } from '@dfai/ui';
import { readAgain, scopedReadKey, scopedReadMeta } from '../reads/query-client.ts';

/** What the recent questions are made from: the notes in `Chats/`. */
const RECENT_SCOPE = { folders: [CHATS_FOLDER] };

const recentKey = (vault: string | null) => scopedReadKey(vault ?? '', 'recent-questions');

export interface RecentQuestions {
  /** The questions, or null while they are read. */
  readonly recent: AskRecent;
  /** Why they could not be read; null when they were, or are being. */
  readonly problem: string | null;
  /** Reads them again: a picked chat turned out to be gone. */
  readonly refresh: () => void;
}

/**
 * The questions asked lately (#37), read once and kept (ADR-0040) until the
 * index has news of `Chats/` — or the chat being shown is kept in a new note,
 * which the list should hold before the index has caught up with it.
 */
export function useRecentQuestions({
  fs,
  vault,
  chatPath,
}: {
  fs: VaultFsPort;
  vault: string | null;
  chatPath: VaultPath | null;
}): RecentQuestions {
  const client = useQueryClient();
  const { data, error } = useQuery<ChatSummary[]>({
    queryKey: recentKey(vault),
    queryFn: () => recentQuestions({ fs }),
    meta: scopedReadMeta(RECENT_SCOPE),
    enabled: vault !== null,
  });
  const refresh = useCallback(() => void readAgain(client, recentKey(vault)), [client, vault]);
  useEffect(() => {
    if (chatPath !== null) refresh();
  }, [refresh, chatPath]);
  return {
    recent: data ?? (error === null ? null : []),
    problem: error === null ? null : `The recent questions could not be read: ${messageOf(error)}`,
    refresh,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
