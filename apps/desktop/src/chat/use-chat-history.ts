import { useCallback, useEffect, useState } from 'react';
import { listChats, type ChatSession, type ChatSummary, type VaultFsPort } from '@dfai/application';
import type { VaultPath } from '@dfai/domain';
import { usePickChat } from './use-pick-chat.ts';

/** The sidebar's Past chats, as the panel draws them. */
export interface ChatHistory {
  readonly chats: readonly ChatSummary[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (path: string) => void;
  /** Why the list could not be read, or the chat picked opened; null when all is well. */
  readonly problem: string | null;
}

/**
 * The sidebar's Past chats, read from `Chats/` each time the list opens. A
 * list that cannot be read says so, never "No chats yet". A pick that cannot
 * be opened — its note deleted underneath — opens the list again with why,
 * read afresh so the row goes.
 */
export function useChatHistory({
  session,
  fs,
  chatPath,
}: {
  session: Pick<ChatSession, 'open'>;
  fs: VaultFsPort | null;
  chatPath: VaultPath | null;
}): ChatHistory {
  const [open, setOpen] = useState(false);
  const [reads, setReads] = useState(0);
  const listing = useChatList({ open, fs, chatPath, reads });
  const refresh = useCallback(() => {
    setOpen(true);
    setReads((count) => count + 1);
  }, []);
  const pick = usePickChat({ open: session.open, refresh });
  return {
    chats: listing.chats,
    open,
    problem: pick.problem ?? listing.problem,
    onOpenChange: (next) => {
      setOpen(next);
      if (!next) pick.clear();
    },
    onPick: (path) => {
      setOpen(false);
      pick.onPick(path);
    },
  };
}

/** The chats in `Chats/`, read while the list is open: again on each change of `reads`. */
function useChatList({
  open,
  fs,
  chatPath,
  reads,
}: {
  open: boolean;
  fs: VaultFsPort | null;
  chatPath: VaultPath | null;
  reads: number;
}) {
  const [chats, setChats] = useState<readonly ChatSummary[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open || fs === null) return;
    let current = true;
    listChats({ fs })
      .then((found) => {
        if (!current) return;
        setChats(found);
        setProblem(null);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setChats([]);
        setProblem(`Past chats could not be read: ${messageOf(error)}`);
      });
    return () => {
      current = false;
    };
  }, [open, fs, chatPath, reads]);
  return { chats, problem };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
