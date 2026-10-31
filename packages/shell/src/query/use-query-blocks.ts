import { useCallback, useMemo, useRef } from 'react';
import type { ObjectType } from '@dfai/domain';
import { AtlasQueryError, runQueryBlock, type IndexPort } from '@dfai/application';
import { useNoteNames, type NoteQueryBlocks, type QueryBlockShown } from '@dfai/ui';
import { errorMessage } from './error-message.ts';
import { answerRows } from './use-atlas-query.ts';

/** What a note's query blocks are asked against, as the page has it now. */
interface Asked {
  readonly index: IndexPort;
  readonly types: readonly ObjectType[];
  readonly notePaths: readonly string[];
  readonly notePath: string;
}

/**
 * Where a note's query blocks (P30-05) are answered: each block's text run
 * as a DFAI query in which `this` is this note, its rows grouped for the
 * layout the block says. Every block asks again whenever `revision` — the
 * index's count of changes — moves, so a note saved anywhere reaches them.
 * Undefined where there is no note to be `this`.
 */
export function useQueryBlocks({
  index,
  types,
  notePaths,
  notePath,
  revision,
  onOpenNote,
}: Omit<Asked, 'notePath'> & {
  notePath: string | null;
  revision: string;
  onOpenNote: (path: string) => void;
}): NoteQueryBlocks | undefined {
  const names = useNoteNames();
  const asked = useRef<Asked | null>(null);
  asked.current = notePath === null ? null : { index, types, notePaths, notePath };

  const run = useCallback(
    async (text: string): Promise<QueryBlockShown> => {
      const now = asked.current;
      if (now === null) return { kind: 'problem', message: 'A query block runs inside a note.' };
      try {
        const { layout, answer } = await runQueryBlock({ ...now, text });
        const { fields, rows, groups } = answerRows({ answer, layout, names });
        return {
          kind: 'rows',
          result: { layout, fields, rows, groups },
          truncated: answer.result.truncated,
        };
      } catch (cause) {
        const message = cause instanceof AtlasQueryError ? cause.message : errorMessage(cause);
        return { kind: 'problem', message };
      }
    },
    [names],
  );

  const hasNote = notePath !== null;
  return useMemo(
    () => (hasNote ? { run, onOpenNote, revision } : undefined),
    [hasNote, run, onOpenNote, revision],
  );
}
