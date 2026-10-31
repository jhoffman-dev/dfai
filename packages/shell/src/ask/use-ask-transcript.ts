import { useMemo, useRef } from 'react';
import { askTranscript, type AskEntry, type ChatState } from '@dfai/application';
import type { AskState } from '@dfai/ui';

/**
 * The chat's state as Ask draws it, each answer read for its citations. The
 * last transcript is kept, so a streamed word re-reads only its own answer.
 */
export function useAskState(state: ChatState): AskState {
  const last = useRef<readonly AskEntry[]>([]);
  return useMemo(() => {
    const entries = askTranscript(state, last.current);
    last.current = entries;
    return { entries, busy: state.busy, error: state.error, notice: state.notice };
  }, [state]);
}
