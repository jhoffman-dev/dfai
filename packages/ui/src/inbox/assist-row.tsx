import { useEffect, useRef } from 'react';
import { focusIsHome } from '../row-keys.ts';

/** Where a row stands with being applied (#909), said already: the page decides nothing about it. */
export type AssistRowAction =
  /** A question, or an item left: nothing to press. */
  | { readonly kind: 'none' }
  /** Shown, not applied for now (#925): it would move the note. Why, and nothing to press. */
  | { readonly kind: 'preview'; readonly words: string }
  /** Offered: Apply. A row that asked, or failed, says why beside it. */
  | { readonly kind: 'apply'; readonly said: string | null }
  /** Being applied, or undone. */
  | { readonly kind: 'busy'; readonly words: string }
  /** Applied: what was done, and Undo; an undo refused says why beside it. */
  | { readonly kind: 'applied'; readonly words: string; readonly problem: string | null }
  /** Asked at the press instead: why. Nothing was written. */
  | { readonly kind: 'asked'; readonly words: string }
  /** Taken back. */
  | { readonly kind: 'undone'; readonly words: string };

/** One item's row, said already: the page decides nothing about it. */
export interface AssistRowView {
  readonly path: string;
  readonly title: string;
  /** What would be done, in DFAI's words. */
  readonly does: string;
  /** One short reason. */
  readonly why: string;
  /** How its chip is drawn: filed, a duplicate, a question, or left. */
  readonly tone: 'file' | 'duplicate' | 'ask' | 'leave';
  /** What would be done about the people it names, a line each: "Links Mara Quill". */
  readonly people: readonly string[];
  /** Where it stands with being applied; left out, or `none`, where nothing can be. */
  readonly action?: AssistRowAction;
  /**
   * What the person applying it should check (#911): Claude chose its kind and
   * project, and nothing in the item confirms them. Left out for none.
   */
  readonly caution?: string | null;
}

const NO_ACTION: AssistRowAction = { kind: 'none' };

/** What a row's buttons do, by the row's path. */
export interface AssistRowActions {
  readonly onApply: (path: string) => void;
  readonly onUndo: (path: string) => void;
}

/** A chip's pastel, from the statuses' own: neutral chrome round it. */
const TONE_PILL: Readonly<Record<AssistRowView['tone'], string>> = {
  file: 'next',
  duplicate: 'review',
  ask: 'waiting',
  leave: 'backlog',
};

const TONE_WORD: Readonly<Record<AssistRowView['tone'], string>> = {
  file: 'Would act',
  duplicate: 'Duplicate',
  ask: 'Question',
  leave: 'Would leave',
};

/**
 * One item in the suggestions: what would be done and why, and — for a row
 * that can be applied — Apply, then what was done and Undo. As a row's
 * button gives way to the next, the focus goes with it, so the keyboard
 * stays on the row it pressed.
 */
export function AssistRow({
  row,
  actions,
}: {
  row: AssistRowView;
  actions: AssistRowActions | null;
}) {
  return (
    <li className="inbox-assist__row" aria-label={row.title}>
      <span className="inbox-assist__title">{row.title}</span>
      <span className="status-pill" data-tone={TONE_PILL[row.tone]}>
        {TONE_WORD[row.tone]}
      </span>
      <span className="inbox-assist__does">{row.does}</span>
      {row.people.map((line) => (
        <span key={line} className="inbox-assist__person">
          {line}
        </span>
      ))}
      {row.why !== '' && <small className="inbox-assist__why">{row.why}</small>}
      {actions !== null && typeof row.caution === 'string' && row.action?.kind === 'apply' && (
        <small className="inbox-assist__caution">{row.caution}</small>
      )}
      {/* Shown whether or not anything else can be applied: why this one waits. */}
      {row.action?.kind === 'preview' && (
        <span className="inbox-assist__act">
          <span className="inbox-assist__said">{row.action.words}</span>
        </span>
      )}
      {actions !== null && <RowAction row={row} actions={actions} />}
    </li>
  );
}

function RowAction({ row, actions }: { row: AssistRowView; actions: AssistRowActions }) {
  const action = row.action ?? NO_ACTION;
  const { button, words } = useFollowingFocus(action.kind);
  switch (action.kind) {
    case 'none':
    case 'preview':
      return null;
    case 'apply':
      return (
        <span className="inbox-assist__act">
          {action.said !== null && <span className="inbox-assist__said">{action.said}</span>}
          <button
            type="button"
            className="btn btn--sm"
            ref={button}
            onClick={() => actions.onApply(row.path)}
          >
            Apply
          </button>
        </span>
      );
    case 'applied':
      return (
        <span className="inbox-assist__act">
          <span className="inbox-assist__done">{action.words}</span>
          {action.problem !== null && <span className="inbox-assist__said">{action.problem}</span>}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            ref={button}
            onClick={() => actions.onUndo(row.path)}
          >
            Undo
          </button>
        </span>
      );
    default:
      return (
        <span className="inbox-assist__act" tabIndex={-1} ref={words}>
          <span className={action.kind === 'busy' ? 'inbox-assist__busy' : 'inbox-assist__said'}>
            {action.words}
          </span>
        </span>
      );
  }
}

/**
 * Moves the focus to what a row shows next — its button, or its words — once
 * the control that had it is gone: pressed Apply is replaced by Undo, say.
 * Focus that fell to nothing, or to the page's own home, was lost rather than
 * moved (the page takes it back when it falls); anywhere else, it is left.
 */
function useFollowingFocus(kind: AssistRowAction['kind']) {
  const button = useRef<HTMLButtonElement>(null);
  const words = useRef<HTMLSpanElement>(null);
  const was = useRef(kind);
  const had = useRef(false);
  useEffect(() => {
    const changed = was.current !== kind;
    was.current = kind;
    if (changed && (had.current || focusIsHome())) (button.current ?? words.current)?.focus();
  }, [kind]);
  useEffect(() => {
    const track = () => {
      if (focusIsHome()) return;
      had.current = [button.current, words.current].some(
        (each) => each !== null && each === document.activeElement,
      );
    };
    document.addEventListener('focusin', track);
    return () => document.removeEventListener('focusin', track);
  }, []);
  return { button, words };
}
