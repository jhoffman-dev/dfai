import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  builderFromQuery,
  boardGroups,
  groupResultRows,
  parseAtlasQuery,
  printAtlasQuery,
  queryableFields,
  queryFromBuilder,
  QueryTextError,
  resultFields,
  toBoardRows,
  type BoardRow,
  type BuilderQuery,
  type NoteNames,
  type ObjectType,
  type QueryProblem,
  type ViewLayout,
} from '@dfai/domain';
import {
  AtlasQueryError,
  runAtlasQuery,
  type AtlasQueryAnswer,
  type IndexPort,
  type ReadMoment,
} from '@dfai/application';
import { useSteadyCallback, type ComposerMode, type GroupedResultProps } from '@dfai/ui';
import { errorMessage } from './error-message.ts';

/** How the query was last opened in the editor: as dropdowns, or as text and why. */
interface Editing {
  readonly mode: ComposerMode;
  readonly builder: BuilderQuery | null;
  /** Why the builder cannot show the query; it stays text. */
  readonly textOnly: string | null;
}

/**
 * The editor for one DFAI query (ADR-0019): its text, the builder's view of
 * it, and its answer, re-asked whenever the text or the index changes.
 *
 * While the builder is open it holds the query — a condition still waiting
 * for its value included — and the text is what it prints. Opening the text
 * hands the query over as that text; opening the builder again reads the text
 * back, or says why it cannot and leaves it as text.
 */
export function useAtlasQuery({
  initialText,
  index,
  types,
  notePaths,
  indexKey,
  indexKeyNow,
  enabled = true,
  taskRows = false,
}: {
  initialText: string;
  index: IndexPort;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  indexKey: string;
  /**
   * The index's own key as it stands when asked, which each run is stamped
   * with as it begins (#698).
   */
  indexKeyNow: () => string;
  /** False while there is no query to ask — a pane holding an ordinary note. */
  enabled?: boolean;
  /** Whether a query of tasks alone carries each task's state, for its row's controls (#107). */
  taskRows?: boolean;
}) {
  const [text, setTextState] = useState(initialText);
  const [editing, setEditing] = useState<Editing>(() => editingFor(initialText));
  // Typed text is asked about once typing pauses; a pick in the builder at once.
  const asked = useSettled(text, editing.mode === 'text' ? TYPING_PAUSE_MS : 0);
  const keyNow = useSteadyCallback(indexKeyNow);
  const run = useRunning({
    text: asked,
    index,
    types,
    notePaths,
    indexKey,
    keyNow,
    enabled,
    taskRows,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const setBuilder = useCallback((builder: BuilderQuery) => {
    setEditing({ mode: 'builder', builder, textOnly: null });
    setTextState(printAtlasQuery(queryFromBuilder(builder)));
  }, []);

  const setText = useCallback((next: string) => {
    setTextState(next);
    setEditing({ mode: 'text', builder: null, textOnly: null });
  }, []);

  const setMode = useCallback(
    (mode: ComposerMode) =>
      setEditing(mode === 'text' ? { mode, builder: null, textOnly: null } : editingFor(text)),
    [text],
  );

  /** Starts again from this text: a saved view reset, or another view opened. */
  const load = useCallback((next: string) => {
    setTextState(next);
    setEditing(editingFor(next));
  }, []);

  // Keyed by the types named, not the text: a keystroke that names no new type asks for nothing.
  const from = (editing.builder?.types ?? typesNamedIn(text)).join(',');
  const fields = useMemo(
    () => queryableFields(types, from === '' ? [] : from.split(',')),
    [types, from],
  );

  return {
    text,
    setText,
    load,
    mode: editing.mode,
    setMode,
    builder: editing.builder,
    setBuilder,
    textOnly: editing.textOnly,
    fields,
    ...run,
    collapsed,
    toggleGroup: useCallback(
      (id: string) =>
        setCollapsed((was) => {
          const next = new Set(was);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      [],
    ),
  };
}

/** Before anything has been read: before every write. */
const NOT_READ: ReadMoment = { at: 0, indexKey: '' };

/** How long typing must pause before the text is run: a query per keystroke is felt on a big vault. */
const TYPING_PAUSE_MS = 200;

/** `value`, once it has held still for `delay` milliseconds; at once when `delay` is 0. */
function useSettled(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (delay === 0) {
      setSettled(value);
      return;
    }
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return delay === 0 ? value : settled;
}

/** The builder, when it can show the text; the text, with the reason, when it cannot. */
function editingFor(text: string): Editing {
  let query;
  try {
    query = parseAtlasQuery(text);
  } catch (cause) {
    if (!(cause instanceof QueryTextError)) throw cause;
    return {
      mode: 'text',
      builder: null,
      textOnly: `Fix the query to open it in the builder: ${cause.message}`,
    };
  }
  const reading = builderFromQuery(query);
  return reading.ok
    ? { mode: 'builder', builder: reading.builder, textOnly: null }
    : { mode: 'text', builder: null, textOnly: reading.reason };
}

function typesNamedIn(text: string): string[] {
  try {
    return parseAtlasQuery(text).from.map((name) => name.text);
  } catch {
    // Text that does not read names no types yet: the builder is not open over it.
    return [];
  }
}

/** Runs the text whenever it, the types or the index change; a stale answer never lands. */
function useRunning({
  text,
  index,
  types,
  notePaths,
  indexKey,
  keyNow,
  enabled,
  taskRows,
}: {
  text: string;
  index: IndexPort;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  /** The index's news: the text runs again on it. */
  indexKey: string;
  /** The index's own key now, which each run is stamped with as it begins (#698). */
  keyNow: () => string;
  enabled: boolean;
  taskRows: boolean;
}) {
  const [answer, setAnswer] = useState<AtlasQueryAnswer | null>(null);
  // When the answer on screen was asked, among the runs begun: a row acted on
  // is drawn as changed until a run asked after its write stands for it (#107).
  const [read, setRead] = useState<ReadMoment>(NOT_READ);
  const begun = useRef(0);
  const runsBegun = useCallback(() => begun.current, []);
  const [problem, setProblem] = useState<QueryProblem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setAnswer(null);
      setProblem(null);
      setError(null);
      return;
    }
    let cancelled = false;
    begun.current += 1;
    const asked = { at: begun.current, indexKey: keyNow() };
    runAtlasQuery({ index, text, types, notePaths, taskRows })
      .then((found) => {
        if (cancelled) return;
        setAnswer(found);
        setRead(asked);
        setProblem(null);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A problem in the text keeps the last answer on screen while it is fixed.
        if (cause instanceof AtlasQueryError && cause.problem !== null) {
          setProblem(cause.problem);
          setError(null);
          return;
        }
        setProblem(null);
        setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [index, text, types, notePaths, indexKey, keyNow, runs, enabled, taskRows]);

  return {
    answer,
    read,
    runsBegun,
    problem,
    error,
    rerun: useCallback(() => setRuns((count) => count + 1), []),
  };
}

/** The answer as the result panel draws it, grouped for the layout. */
export function resultFor({
  answer,
  layout,
  names,
  rows,
}: {
  answer: AtlasQueryAnswer | null;
  layout: ViewLayout;
  /** The vault's notes, which a relation's groups are named by. */
  names: NoteNames;
  /** The answer's rows as drawn, when not as read: each row's own change laid over (#107). */
  rows?: readonly BoardRow[];
}): Pick<GroupedResultProps, 'fields' | 'rows' | 'groups' | 'lanes'> | null {
  return answer === null
    ? null
    : answerRows({ answer, layout, names, ...(rows !== undefined && { rows }) });
}

/** An answer's rows as the result panel draws them, grouped for the layout. */
export function answerRows({
  answer,
  layout,
  names,
  rows = toBoardRows(answer.result),
}: {
  answer: AtlasQueryAnswer;
  layout: ViewLayout;
  /** The vault's notes, which a relation's groups are named by. */
  names: NoteNames;
  /** The answer's rows as drawn; as read unless said. */
  rows?: readonly BoardRow[];
}): Pick<GroupedResultProps, 'fields' | 'rows' | 'groups' | 'lanes'> {
  const fields = resultFields(answer.compiled);
  // A board's columns are its groups, so a group nothing is in still stands;
  // a second level is its swimlanes, every column running through each.
  if (layout === 'board') {
    const { columns, lanes } = boardGroups({ rows, levels: answer.compiled.groups, names });
    return { fields, rows, groups: columns, lanes };
  }
  return { fields, rows, groups: groupResultRows({ rows, groups: answer.compiled.groups, names }) };
}
