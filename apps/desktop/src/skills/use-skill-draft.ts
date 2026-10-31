import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { skillTextChanges, type SkillDraft } from '@dfai/domain';
import { draftSkill, type ModelProvider, type SkillDraftOutcome } from '@dfai/application';
import type { SkillAskProblem, SkillAskView, SkillDraftPreview, SkillEditorState } from '@dfai/ui';

/** How the Skills page reaches Claude: the chat's chosen provider and model, read at each ask. */
export interface SkillDraftPorts {
  readonly provider: () => ModelProvider;
  readonly model: () => string;
}

/** The ask as it stands: the field, and what the last ask came to. */
interface AskState {
  readonly open: boolean;
  readonly request: string;
  readonly asking: boolean;
  readonly outcome: SkillDraftOutcome | null;
}

const CLOSED: AskState = { open: false, request: '', asking: false, outcome: null };

const isBlank = (draft: SkillDraft) =>
  draft.name === '' && draft.description === '' && draft.instructions === '';

/** What the page says when an ask gave nothing to accept; null when it did, or was stopped. */
function problemOf(outcome: SkillDraftOutcome | null): SkillAskProblem | null {
  if (outcome === null) return null;
  switch (outcome.kind) {
    case 'refused':
      return { lines: ['Claude’s draft cannot be used:', ...outcome.problems], fix: null };
    case 'unready':
      return { lines: [outcome.message], fix: outcome.fix };
    case 'unasked':
    case 'failed':
      // In its own words, as the chat says a failed turn.
      return { lines: [outcome.message], fix: null };
    default:
      return null;
  }
}

/** The draft against the editor as it is now, so the preview shows exactly what Accept changes. */
function previewOf(
  outcome: SkillDraftOutcome | null,
  editor: SkillEditorState,
): SkillDraftPreview | null {
  if (outcome?.kind !== 'drafted') return null;
  const { draft, ignoredName } = outcome;
  const now = editor.draft;
  return {
    name: editor.mode === 'new' && draft.name !== now.name ? draft.name : null,
    description: skillTextChanges(now.description, draft.description),
    instructions: skillTextChanges(now.instructions, draft.instructions),
    note:
      ignoredName === null
        ? null
        : `Claude named it “${ignoredName}”; a skill keeps its folder’s name, so it stays “${now.name}”.`,
  };
}

/**
 * Ask Claude on the Skills page (#169, ADR-0050): the request, the ask and
 * Stop, and Claude's draft as a change to the editor. Accept only fills the
 * editor's fields; Save is still the one write. A different skill opened, or
 * the page closed, stops an ask under way and forgets it.
 */
export function useSkillDraft({
  ports,
  editor,
  opening,
  onChange,
}: {
  ports: SkillDraftPorts;
  editor: SkillEditorState | null;
  /** Counts each skill, or new one, opened in the editor: a new count is another ask. */
  opening: number;
  onChange: (change: Partial<SkillDraft>) => void;
}): SkillAskView | undefined {
  const [state, setState] = useState<AskState>(CLOSED);
  const running = useRef<AbortController | null>(null);
  const stop = useCallback(() => {
    running.current?.abort();
    running.current = null;
  }, []);
  // What the ask is about: the editor as opened. Another one, or none, is another ask.
  const subject = editor === null ? null : opening;
  useEffect(() => {
    setState(CLOSED);
    return stop;
  }, [subject, stop]);

  const latest = useRef(editor);
  latest.current = editor;
  const ask = useCallback(
    (request: string) => {
      const shown = latest.current;
      if (shown === null) return;
      stop();
      const own = new AbortController();
      running.current = own;
      setState((was) => ({ ...was, asking: true, outcome: null }));
      const fixedName = shown.mode === 'edit' ? shown.draft.name : null;
      draftSkill({
        provider: ports.provider(),
        model: ports.model(),
        current: isBlank(shown.draft) ? null : shown.draft,
        fixedName,
        request,
        signal: own.signal,
      })
        .catch((error: unknown): SkillDraftOutcome => ({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }))
        .then((outcome) => {
          // Stopped, or overtaken by another ask or another skill: this answer is no longer wanted.
          if (running.current !== own) return;
          running.current = null;
          setState((was) => ({
            ...was,
            asking: false,
            outcome: outcome.kind === 'stopped' ? null : outcome,
          }));
        });
    },
    [ports, stop],
  );

  const accepted = state.outcome?.kind === 'drafted' ? state.outcome.draft : null;
  const preview = useMemo(
    () => (editor === null ? null : previewOf(state.outcome, editor)),
    [state.outcome, editor],
  );
  if (editor === null) return undefined;
  return {
    open: state.open,
    request: state.request,
    asking: state.asking,
    preview,
    problem: problemOf(state.outcome),
    onOpen: () => setState({ ...CLOSED, open: true }),
    onClose: () => {
      stop();
      setState(CLOSED);
    },
    onRequestChange: (request) => setState((was) => ({ ...was, request })),
    onAsk: () => ask(state.request.trim()),
    onStop: () => {
      stop();
      setState((was) => ({ ...was, asking: false }));
    },
    onAccept: () => {
      if (accepted === null) return;
      // The whole draft: the domain has already given an existing skill its own name.
      onChange(accepted);
      setState(CLOSED);
    },
    onDiscard: () => setState(CLOSED),
  };
}
