import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NO_LINK_HINTS } from '@dfai/domain';
import { readLinkHints, type IndexPort, type LinkHintsRead } from '@dfai/application';
import { LinkHintsProvider, type LinkHintsSource } from '@dfai/ui';
import { indexKeyOf, type IndexStatusStore } from '../index/index-status-store.ts';
import { errorMessage } from '../query/error-message.ts';

/** One read, and the vault and index it was read from. */
type Read =
  | { readonly at: string; readonly read: LinkHintsRead }
  | { readonly at: string; readonly problem: string };

const NOT_READ = 'The notes to suggest could not be read. Close this and try again.';

/**
 * Hands every link field the notes' aliases, their use and every note
 * (#465) — read when a picker first opens, never before, and again on a
 * later opening once the index has moved on. The index's key is looked at
 * only then, not watched: news from the index draws nothing here. Only the
 * open picker reads what this gives, so a read landing draws that picker
 * alone, not the page under it (`children` are the caller's elements).
 */
export function LinkHintsHost({
  index,
  status,
  vault,
  children,
}: {
  index: Pick<IndexPort, 'query'>;
  status: IndexStatusStore;
  vault: string | null;
  children: ReactNode;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const latest = useRef({ index, status, vault, read });
  useLayoutEffect(() => {
    latest.current = { index, status, vault, read };
  });
  // The read under way, by where it reads: a second opening while it runs asks nothing more.
  const reading = useRef<string | null>(null);

  const want = useCallback(() => {
    const now = latest.current;
    const at = `${now.vault ?? ''}|${indexKeyOf(now.status.getState(), now.vault)}`;
    if ((now.read?.at === at && 'read' in now.read) || reading.current === at) return;
    reading.current = at;
    const settle = (next: Read) => {
      if (reading.current === at) reading.current = null;
      // A read from a vault no longer open is not this vault's.
      if (latest.current.vault === now.vault) setRead(next);
    };
    readLinkHints({ index: now.index }).then(
      (found) => settle({ at, read: found }),
      (cause: unknown) => settle({ at, problem: `${NOT_READ} (${errorMessage(cause)})` }),
    );
  }, []);

  const shown = read !== null && read.at.startsWith(`${vault ?? ''}|`) ? read : null;
  const source = useMemo<LinkHintsSource>(
    () => ({
      hints: shown !== null && 'read' in shown ? shown.read.hints : NO_LINK_HINTS,
      notes: shown !== null && 'read' in shown ? shown.read.notes : null,
      problem: shown !== null && 'problem' in shown ? shown.problem : null,
      want,
    }),
    [shown, want],
  );
  return <LinkHintsProvider value={source}>{children}</LinkHintsProvider>;
}
