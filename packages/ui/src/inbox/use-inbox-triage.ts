import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FocusEvent,
  type MutableRefObject,
  type KeyboardEvent,
  type PointerEvent,
  type SetStateAction,
} from 'react';
import { useRowHandles } from '../row-handles.ts';
import { focusIsHome, typesInto, useRowKeys, type UndoLast } from '../row-keys.ts';
import { useSteadyCallback } from '../steady-callback.ts';
import {
  GTD_STATUSES,
  triageActionOf,
  type Clarification,
  type GtdStatus,
  type InboxItem,
  type TriageAction,
  type VaultPath,
} from '@dfai/domain';
import { clarificationOf, rowAfter, rowAfterLeaving, type InboxDraft } from './inbox-triage.ts';

/** Clarifies a note; settles true once it is done, false when it was refused. */
export type ClarifyInboxItem = (args: {
  path: VaultPath;
  clarification: Clarification;
}) => Promise<boolean>;

const NOTHING_PICKED: InboxDraft = {};

/** Where a row that left holding the focus, with no row to hand it to, is kept. */
export type StrandedRow = MutableRefObject<VaultPath | null>;

/**
 * A picker P or T opened. What writes its pick is an explicit act on the
 * picker: for the project, picking a suggestion, which the field hands over
 * only on ↵, Tab or a click; for the date, Enter or a pointer pick from the
 * opened picker — never a `change` alone, since a date changes with each
 * segment typed or cleared. Until then a pick is held on the row as any is.
 */
interface ArmedPicker {
  readonly path: VaultPath;
  readonly field: 'project' | 'defer';
  /** What the row held for that field when the key armed it: Escape gives it back. */
  readonly before: string | undefined;
}

type PickerElement = HTMLSelectElement | HTMLInputElement;

/**
 * Working through the Inbox a row at a time (#112): which row has the focus,
 * what each task's row holds until Done, and the actions a row offers. The
 * controls call these; the triage keys (#109) call the same ones.
 *
 * An action that is done moves the focus to the next row, so the list is
 * worked top to bottom without reaching for it; a refused one leaves the
 * focus, and what was picked, where it is. The next row may not be in the
 * DOM — the list is virtualised (#238) — so it is `wanted` until it is drawn.
 */
export function useInboxTriage({
  items,
  statuses = GTD_STATUSES,
  onClarify,
  busy = false,
  stranded: keptStranded,
  onOpen,
  onUndo,
}: {
  items: readonly InboxItem[];
  /** The statuses the vault's Task type declares: a key for one it lacks does nothing. */
  statuses?: readonly GtdStatus[];
  onClarify: ClarifyInboxItem;
  /** While the row's own controls are disabled, so are its keys. */
  busy?: boolean;
  /** Kept by whatever outlives the rows: the list unmounts once it is empty. */
  stranded?: StrandedRow;
  /** Opens a row's note: Return on the row (#109). */
  onOpen: (path: VaultPath) => void;
  /** Takes the last clarification back: U or ⌘Z on a row (#109). */
  onUndo?: UndoLast | undefined;
}) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, InboxDraft>>>({});
  const [focused, setFocused] = useState<VaultPath | null>(null);
  const order = useMemo(() => items.map((item) => item.path), [items]);
  const handles = useRowHandles(order);
  const { focusRow: focusPlaced, elementOf } = handles;
  // Read when a row is acted on, so the actions stay the same from one list to
  // the next and a row that has not changed is not drawn again (#217).
  const listed = useRef(items);
  // The row a key lands on: the one the focus is in, kept where the key
  // handler can read it without being made anew on each render.
  const focusedRow = useRef<VaultPath | null>(null);
  // Whether a row holds the focus now, not merely held it last: only then does a row leaving hand it on.
  const rowHasFocus = useRef(false);
  // A row that left holding the focus with no row to hand it to: it takes the focus back should it return.
  const ownStranded = useRef<VaultPath | null>(null);
  const stranded = keptStranded ?? ownStranded;
  const declared = useRef(statuses);
  declared.current = statuses;
  const idle = useRef(!busy);
  idle.current = !busy;
  const armed = useRef<ArmedPicker | null>(null);
  // Whether the pointer opened the armed picker's list: then the pick that follows is a pick, not typeahead.
  const pointed = useRef(false);
  // What each row holds, read when a key acts on a row.
  const held = useRef(drafts);
  held.current = drafts;

  // The app makes its callback anew on many of its renders; the rows' actions stay the same.
  const clarify = useSteadyCallback(onClarify);
  // The rows being written, by how many writes each: one that leaves the list
  // meanwhile is the app's, which brings it back, picks and all, should it be refused.
  const writing = useRef(new Map<VaultPath, number>());
  // Rows whose write was refused. The app brings such a row back as it refuses, so a
  // refused row the list then lacks was taken away meanwhile — by sync, say — and its
  // picks go with it. Read after the render that follows, when the list is the app's answer.
  const refused = useRef(new Set<VaultPath>());
  const [refusals, setRefusals] = useState(0);

  const focusRow = useCallback(
    (path: VaultPath) => {
      setFocused(path);
      focusedRow.current = path;
      rowHasFocus.current = true;
      stranded.current = null;
      focusPlaced(path);
    },
    [focusPlaced],
  );

  // The app takes a row off the list as soon as it is acted on and writes it
  // after (#260): the focus it held goes on to the next row then, not once the
  // write is done, so the next key lands there and not on the page. Only the
  // row that held the focus as it left, in this change, hands it on (#423).
  useEffect(() => {
    const before = listed.current;
    listed.current = items;
    forgetPicksOfRowsGone({ before, items, writing: writing.current, setDrafts });
    const back = stranded.current;
    if (back !== null && items.some((item) => item.path === back)) {
      // Its write refused, the last row is back: the next key is for it, unless the focus has gone elsewhere.
      stranded.current = null;
      if (focusLeftWithRow()) focusRow(back);
      return;
    }
    const path = focusedRow.current;
    if (path === null || items.some((item) => item.path === path)) return;
    const handsOn = rowHasFocus.current && focusLeftWithRow();
    focusedRow.current = null;
    rowHasFocus.current = false;
    if (!handsOn) return;
    const next = rowAfterLeaving(before, items, path);
    if (next !== null) focusRow(next);
    else if (before.some((item) => item.path === path)) stranded.current = path;
  }, [items, focusRow, stranded]);

  useEffect(() => {
    const gone = [...refused.current].filter(
      (path) => !writing.current.has(path) && !listed.current.some((item) => item.path === path),
    );
    refused.current.clear();
    if (gone.length === 0) return;
    setDrafts((held) =>
      Object.fromEntries(
        Object.entries(held).filter(([path]) => !gone.includes(path as VaultPath)),
      ),
    );
  }, [refusals]);

  // The last row leaving empties the list, and the page draws no rows at all:
  // what held the focus is kept where the page can give it back.
  useEffect(
    () => () => {
      const path = focusedRow.current;
      if (path !== null && rowHasFocus.current && focusLeftWithRow()) stranded.current = path;
    },
    [stranded],
  );

  const act = useCallback(
    async (path: VaultPath, clarification: Clarification) => {
      const next = rowAfter(listed.current, path);
      writing.current.set(path, (writing.current.get(path) ?? 0) + 1);
      const done = await clarify({ path, clarification }).finally(() => {
        const left = (writing.current.get(path) ?? 1) - 1;
        if (left === 0) writing.current.delete(path);
        else writing.current.set(path, left);
      });
      if (!done) {
        // Looked at once the app's own answer to the refusal is drawn: see `refused`.
        refused.current.add(path);
        setRefusals((count) => count + 1);
        return;
      }
      setDrafts((held) => Object.fromEntries(Object.entries(held).filter(([at]) => at !== path)));
      // Focus that has gone elsewhere since — another note opened, say — is left there.
      const at = document.activeElement;
      const onPage = at === document.body && focusedRow.current === path && rowHasFocus.current;
      const stillHere = onPage || elementOf(path)?.contains(at) === true;
      if (next !== null && stillHere) focusRow(next);
    },
    [clarify, focusRow, elementOf],
  );

  /** Writes what a picker opened by P or T picked, at once; nothing when it changes nothing. */
  const writePick = useCallback(
    (path: VaultPath, picked: InboxDraft) => {
      const item = listed.current.find((each) => each.path === path);
      if (item === undefined) return;
      if (item.task === null) {
        if (picked.project !== undefined) void act(path, { project: picked.project });
        return;
      }
      const clarification = clarificationOf(item.task, picked);
      if (clarification !== null) void act(path, clarification);
    },
    [act],
  );

  /** One key's action on a row (#109): a status written at once, or a picker opened and armed. */
  const keyAction = useCallback(
    (path: VaultPath, action: TriageAction) => {
      const item = listed.current.find((each) => each.path === path);
      if (item === undefined) return;
      if (action.kind === 'status') {
        if (item.task === null) return;
        // What the row holds goes with the status, in the one save: a key never drops a pick on the floor.
        const withHeld = clarificationOf(item.task, {
          ...held.current[path],
          status: action.status,
        });
        void act(path, withHeld ?? { status: action.status });
        return;
      }
      const picker = elementOf(path)?.querySelector<PickerElement>(
        `[data-field="${action.field}"]`,
      );
      if (picker === null || picker === undefined || picker.disabled) return;
      armed.current = { path, field: action.field, before: held.current[path]?.[action.field] };
      pointed.current = false;
      picker.focus();
      openPicker(picker);
    },
    [act, elementOf],
  );

  /** Drops the armed picker; with `forget`, also what it picked, giving back what the row held before. */
  const disarm = useCallback((forget: boolean) => {
    const arm = armed.current;
    armed.current = null;
    pointed.current = false;
    if (!forget || arm === null) return;
    setDrafts((was) => {
      const row = was[arm.path] ?? {};
      const rest: { -readonly [K in keyof InboxDraft]: InboxDraft[K] } = { ...row };
      if (arm.before === undefined) delete rest[arm.field];
      else Object.assign(rest, { [arm.field]: arm.before });
      return { ...was, [arm.path]: rest };
    });
  }, []);

  /** Enter on the armed picker: writes what the row holds, the pick included. */
  const commitArmed = useCallback(
    (arm: ArmedPicker) => {
      const item = listed.current.find((each) => each.path === arm.path);
      const draft = held.current[arm.path];
      armed.current = null;
      if (item === undefined || draft === undefined) return;
      if (item.task !== null) {
        const clarification = clarificationOf(item.task, draft);
        if (clarification !== null) void act(arm.path, clarification);
      } else if (draft.project !== undefined) {
        void act(arm.path, { project: draft.project });
      }
    },
    [act],
  );

  const rowKey = useRowKeys({
    order,
    focusRow,
    elementOf,
    onOpen,
    onUndo,
    // The undo on offer is the one before a clarification still being written, and the undo itself writes.
    undoWaits: useCallback(() => writing.current.size > 0 || !idle.current, []),
  });

  /** The key handler, on the list rather than each row: a letter on a focused row, never in a field. */
  const onListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      pointed.current = false;
      if (!(event.target instanceof Element)) return;
      const arm = armed.current;
      if (
        arm !== null &&
        elementOf(arm.path)?.querySelector(`[data-field="${arm.field}"]`) === event.target
      ) {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          disarm(true);
          focusRow(arm.path);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (idle.current && !event.repeat) commitArmed(arm);
        }
        return;
      }
      if (typesInto(event.target)) return;
      const path = focusedRow.current;
      if (path === null || rowKey(event, path)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const action = triageActionOf(event.key, declared.current);
      if (action === null) return;
      event.preventDefault();
      // A key held down repeats; the repeats are not more presses. And a busy Inbox takes none.
      if (event.repeat || !idle.current) return;
      keyAction(path, action);
    },
    [keyAction, elementOf, disarm, focusRow, commitArmed, rowKey],
  );

  /** The pointer opening the armed picker's list: the pick it makes next is its own. */
  const onListPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    const arm = armed.current;
    if (
      arm !== null &&
      event.target instanceof HTMLElement &&
      event.target.dataset['field'] === arm.field
    ) {
      pointed.current = true;
    }
  }, []);

  /** A picker P or T opened and then left is disarmed: what it held waits for Done, as any pick does. */
  const onListBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const left = event.target;
      const list = event.currentTarget;
      if (armed.current !== null && left.dataset['field'] === armed.current.field) disarm(false);
      // Once the focus has settled: a row taken out of the DOM is not the person moving the focus away.
      queueMicrotask(() => {
        if (!left.isConnected || list.contains(document.activeElement)) return;
        rowHasFocus.current = false;
        stranded.current = null;
      });
    },
    [disarm],
  );

  /**
   * A pick on a task's row, or a project for a note. From an armed picker it
   * is written only when the pointer made it — a non-empty one; any other
   * `change` is held on the row until Enter, or Done.
   */
  const route = useCallback(
    (path: VaultPath, picked: InboxDraft, writeNow: () => void) => {
      const arm = armed.current;
      const fromArmed = arm !== null && arm.path === path && picked[arm.field] !== undefined;
      // The project field suggests notes (#465) and changes only on a deliberate pick — ↵, Tab or
      // a click — so its picks are written at once; a date changes with each segment typed.
      const deliberate = arm?.field === 'project' || pointed.current;
      if (fromArmed && !(deliberate && picked[arm.field] !== '')) {
        setDrafts((was) => ({ ...was, [path]: { ...was[path], ...picked } }));
        return;
      }
      if (fromArmed) {
        armed.current = null;
        pointed.current = false;
        writePick(path, { ...held.current[path], ...picked });
        return;
      }
      writeNow();
    },
    [writePick],
  );

  return {
    /** The row the focus is in, or was last in. */
    focused,
    onRowFocus: useCallback((path: VaultPath) => {
      focusedRow.current = path;
      rowHasFocus.current = true;
      stranded.current = null;
      setFocused(path);
    }, []),
    onListKeyDown,
    onListPointerDown,
    onListBlur,
    /** Registers a row's element, so the focus can be put on it. */
    rowRef: handles.rowRef,
    /** A row to focus that the list has yet to draw: it places it. */
    wanted: handles.wanted,
    draftOf: (path: VaultPath): InboxDraft => drafts[path] ?? NOTHING_PICKED,
    /** Holds a pick on a task's row until Done — or Enter, on a picker a key opened. */
    pick: useCallback(
      (path: VaultPath, picked: InboxDraft) =>
        route(path, picked, () =>
          setDrafts((was) => ({ ...was, [path]: { ...was[path], ...picked } })),
        ),
      [route],
    ),
    /** Done: writes everything the task's row holds — `draft` — in one save. */
    commit: useCallback(
      (item: InboxItem, draft: InboxDraft) => {
        const clarification = item.task === null ? null : clarificationOf(item.task, draft);
        if (clarification !== null) void act(item.path, clarification);
      },
      [act],
    ),
    /** Files a note that is not a task under a project or an area at once — from an armed picker, on Enter. */
    fileUnder: useCallback(
      (path: VaultPath, project: VaultPath) =>
        route(path, { project }, () => void act(path, { project })),
      [route, act],
    ),
    /** Makes a plain note a task, which then waits on its own row to be clarified as one. */
    makeTask: useCallback(
      (path: VaultPath) =>
        void clarify({ path, clarification: { asTask: true } }).then((done) => {
          if (done) focusRow(path);
        }),
      [clarify, focusRow],
    ),
    keyAction,
  };
}

/**
 * Forgets what was picked on rows that left the list while not being written —
 * taken away by sync, say — so a note that lands at the same path later is a
 * row of its own, picked nothing. A row scrolled out of the page is still on
 * the list, so it keeps its picks (#238).
 */
function forgetPicksOfRowsGone({
  before,
  items,
  writing,
  setDrafts,
}: {
  before: readonly InboxItem[];
  items: readonly InboxItem[];
  writing: ReadonlyMap<VaultPath, number>;
  setDrafts: Dispatch<SetStateAction<Readonly<Record<string, InboxDraft>>>>;
}): void {
  const listed = new Set(items.map((item) => item.path));
  const gone = new Set(
    before.map((item) => item.path).filter((path) => !listed.has(path) && !writing.has(path)),
  );
  if (gone.size === 0) return;
  setDrafts((held) =>
    Object.keys(held).some((path) => gone.has(path as VaultPath))
      ? Object.fromEntries(Object.entries(held).filter(([path]) => !gone.has(path as VaultPath)))
      : held,
  );
}

/** Whether the focus went with a row that left the DOM: it falls back to the page then. */
function focusLeftWithRow(): boolean {
  // The page's home holds it once the last row has gone (`useInboxHome`).
  return focusIsHome();
}

/**
 * Opens a native picker as a click on it would. `showPicker` needs a user
 * gesture, which the key or the button is; a browser without it, or a
 * jsdom, leaves the picker focused, where Space or ↓ opens it.
 */
function openPicker(picker: PickerElement): void {
  if (!('showPicker' in picker) || typeof picker.showPicker !== 'function') return;
  try {
    picker.showPicker();
  } catch {
    // Safe to ignore: refused only without a user gesture, and the picker has the focus either way.
  }
}

export type InboxTriage = ReturnType<typeof useInboxTriage>;
