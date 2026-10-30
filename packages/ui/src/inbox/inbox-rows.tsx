import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  createVaultPath,
  FILED_UNDER_TYPES,
  GTD_STATUSES,
  GTD_STATUS_LABELS,
  humanizeKey,
  isGtdStatus,
  type GtdStatus,
  type InboxItem,
  type InboxTask,
  type VaultPath,
} from '@dfai/domain';
import { Icon } from '../icon.tsx';
import type { RelationChoice } from '../properties-panel.tsx';
import { LinkCombobox } from '../link-suggest/link-combobox.tsx';
import type { CreateLink } from '../link-suggest/link-suggestions.tsx';
import { useSteadyCallback } from '../steady-callback.ts';
import { Spacer } from '../grouped-rows.tsx';
import { useVirtualRows } from '../virtual-rows.ts';
import { asksWhoItWaitsOn, clarificationOf, type InboxDraft } from './inbox-triage.ts';
import { keyHintStrip } from '../key-hints.tsx';
import type { UndoLast } from '../row-keys.ts';
import { inboxKeyHints, triageKeysShown, type TriageKeyShown } from './triage-keys.ts';
import {
  useInboxTriage,
  type ClarifyInboxItem,
  type InboxTriage,
  type StrandedRow,
} from './use-inbox-triage.ts';

/** Why a row's last clarification was refused or left unfinished. */
export interface InboxRefusal {
  readonly path: VaultPath;
  readonly reason: string;
}

/** Makes a project or an area of a name no note has, resolving to where it was made (#465). */
export type CreateFiling = (request: CreateLink) => Promise<VaultPath>;

export interface InboxRowsProps {
  items: readonly InboxItem[];
  /** The projects and areas a note can be filed under. */
  filing: readonly RelationChoice[];
  /** Left out, the project picker offers no "Create". */
  onCreateFiling?: CreateFiling;
  /** The people a task can wait on. */
  people: readonly RelationChoice[];
  /** The statuses a task may be given; GTD's eight unless said. */
  statuses?: readonly GtdStatus[];
  onOpen: (path: VaultPath) => void;
  onClarify: ClarifyInboxItem;
  /** While a note is being written, so it is not asked for twice. */
  busy: boolean;
  /** Why each refused row's last clarification was refused, shown on that row. */
  refusals: readonly InboxRefusal[];
  /** Why each imported meeting's summary still waits, by path: shown on its row (#186). */
  summaryPending?: ReadonlyMap<string, string>;
  /**
   * Kept by the page, which outlives the rows: the row whose key emptied the
   * list while it held the focus, to take the focus back should it return.
   */
  stranded?: StrandedRow;
  /** Takes the last clarification back: U or ⌘Z on a row (#109). */
  onUndo?: UndoLast | undefined;
}

/** A row's height until it is measured, as WebKit draws a note's. */
const ROW_HEIGHT = 59;

/** Below this width of the list (inbox.css, `data-narrow`) the kind goes and the controls and keys fold. */
const NARROW_BELOW = 1100;

/**
 * Marks the Inbox list narrow, as it is resized, on the element itself: no
 * render, and no container query, which would make the list the offset parent
 * the virtualiser measures from (inbox.css).
 */
function useNarrowMark(body: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const list = body.current?.closest<HTMLElement>('.inbox__list');
    if (list === null || list === undefined) return;
    const mark = (width: number) => list.toggleAttribute('data-narrow', width <= NARROW_BELOW);
    mark(list.clientWidth);
    // Without one (jsdom) the width read now stands.
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(([entry]) => {
      if (entry !== undefined) mark(entry.contentRect.width);
    });
    watch.observe(list);
    return () => watch.disconnect();
  }, [body]);
}

/** A row's cells: its name, its kind, its triage keys, and how it is clarified. */
const ROW_CELLS = 4;

/** The row the table's header takes, so the rows' `aria-rowindex` counts from below it. */
const HEADER_ROWS = 1;

/**
 * The Inbox's rows (#112). A task is clarified where it is: status, project,
 * who it waits on, defer and due are picked on its row and written together
 * by Done. Any other note is filed under a project or an area at once.
 */
export function InboxRows({
  items,
  filing,
  onCreateFiling,
  people,
  statuses = GTD_STATUSES,
  onOpen,
  onClarify,
  busy,
  refusals,
  summaryPending,
  stranded,
  onUndo,
}: InboxRowsProps) {
  const open = useSteadyCallback(onOpen);
  const triage = useInboxTriage({
    items,
    statuses,
    onClarify,
    busy,
    onOpen: open,
    onUndo,
    ...(stranded !== undefined && { stranded }),
  });
  const keys = useMemo(() => items.map((item) => item.path), [items]);
  const triageKeys = useMemo(() => triageKeysShown(statuses), [statuses]);
  const body = useRef<HTMLTableSectionElement>(null);
  useNarrowMark(body);
  const list = useVirtualRows({
    content: body,
    keys,
    estimate: () => ROW_HEIGHT,
    pinned: triage.wanted,
  });
  const placeRef = usePlacedRowRefs(list.measure, triage.rowRef);
  const {
    onRowFocus,
    onListKeyDown,
    onListPointerDown,
    onListBlur,
    keyAction,
    pick,
    commit,
    fileUnder,
    makeTask,
  } = triage;
  const actions = useMemo(
    () => ({ pick, commit, fileUnder, makeTask }),
    [pick, commit, fileUnder, makeTask],
  );
  // The app makes its callback anew on many of its renders; the rows' choices stay the same.
  const steadyCreate = useSteadyCallback(onCreateFiling ?? NO_CREATE);
  const createFiling = onCreateFiling === undefined ? null : steadyCreate;
  const choices = useMemo(
    () => ({ filing, people, statuses, createFiling }),
    [filing, people, statuses, createFiling],
  );
  return (
    <tbody
      ref={body}
      onFocus={list.onFocus}
      onKeyDown={onListKeyDown}
      onPointerDown={onListPointerDown}
      onBlur={onListBlur}
    >
      {list.placed.map(({ key, index, gapBefore }) => {
        const item = items[index];
        if (item === undefined) return null;
        const focused = triage.focused === item.path;
        return (
          <Fragment key={key}>
            {gapBefore > 0 && <Spacer height={gapBefore} width={ROW_CELLS} />}
            <tr
              ref={placeRef(item.path)}
              data-index={index}
              aria-rowindex={index + HEADER_ROWS + 1}
              tabIndex={-1}
              className={`table__row inbox__row${focused ? ' inbox__row--focused' : ''}`}
              onFocus={() => onRowFocus(item.path)}
            >
              <InboxRow
                item={item}
                draft={triage.draftOf(item.path)}
                choices={choices}
                onOpen={open}
                busy={busy}
                refusal={refusals.find((each) => each.path === item.path)?.reason ?? null}
                summaryPending={summaryPending?.get(item.path) ?? null}
                actions={actions}
              />
              {/* Drawn here, not in the row's cells: the focus moving draws no InboxRow again (#217). */}
              <td className="inbox__keys">
                <span className="inbox__keys-strip">
                  {focused &&
                    triageKeys.map((shown) =>
                      !offeredTo(item, shown, filing.length > 0) ? null : (
                        <button
                          key={shown.key}
                          type="button"
                          className={`btn btn--sm inbox__key${shown.status === null ? '' : ` inbox__key--${shown.status}`}`}
                          aria-keyshortcuts={shown.keys}
                          aria-label={`${shown.label}, key ${shown.key.toUpperCase()}`}
                          disabled={busy}
                          onClick={() => keyAction(item.path, shown.action)}
                        >
                          {shown.label}
                          <kbd aria-hidden="true">{shown.key.toUpperCase()}</kbd>
                        </button>
                      ),
                    )}
                </span>
              </td>
            </tr>
          </Fragment>
        );
      })}
      {list.after > 0 && <Spacer height={list.after} width={ROW_CELLS} />}
    </tbody>
  );
}

/** The Inbox's keys, listed above its rows (#109): read by a screen reader too. */
export function inboxKeyStrip(statuses: readonly GtdStatus[] = GTD_STATUSES) {
  return keyHintStrip({ hints: inboxKeyHints(statuses), label: 'Keys for the Inbox' });
}

/**
 * Which keys a row offers: a task every one; any other note only P, which files
 * it. And P only when there is a project or an area to file under.
 */
function offeredTo(item: InboxItem, shown: TriageKeyShown, canFile: boolean): boolean {
  const files = shown.action.kind === 'pick' && shown.action.field === 'project';
  if (files && !canFile) return false;
  return item.task !== null || files;
}

/**
 * Each placed row's ref, the same one for as long as the row is in the page:
 * it registers the row for focus and has the list measure it, and a new ref
 * on every render would measure every row on every render.
 */
function usePlacedRowRefs(
  measure: (element: Element | null) => void,
  rowRef: InboxTriage['rowRef'],
): (path: VaultPath) => (element: HTMLElement | null) => void {
  const [refs] = useState(() => new Map<VaultPath, (element: HTMLElement | null) => void>());
  return (path) => {
    const held = refs.get(path);
    if (held !== undefined) return held;
    const register = rowRef(path);
    const ref = (element: HTMLElement | null) => {
      register(element);
      measure(element);
      if (element === null) refs.delete(path);
    };
    refs.set(path, ref);
    return ref;
  };
}

/** What a row can do, the same from one render to the next. */
type RowActions = Pick<InboxTriage, 'pick' | 'commit' | 'fileUnder' | 'makeTask'>;

interface RowChoices {
  readonly filing: readonly RelationChoice[];
  readonly createFiling: CreateFiling | null;
  readonly people: readonly RelationChoice[];
  readonly statuses: readonly GtdStatus[];
}

/**
 * One row's cells — the `<tr>` around them is placed by the list — drawn again
 * only when what they show has changed: a long Inbox is hundreds of rows,
 * each with a picker of every project, and redrawing them all for one row
 * clarified was what kept the next row waiting (#217).
 */
const InboxRow = memo(function InboxRow({
  item,
  draft,
  choices,
  onOpen,
  busy,
  refusal,
  summaryPending,
  actions,
}: {
  item: InboxItem;
  draft: InboxDraft;
  choices: RowChoices;
  onOpen: (path: VaultPath) => void;
  busy: boolean;
  /** Why this row's last clarification was refused, or null. */
  refusal: string | null;
  /** Why this meeting's summary still waits; null when it waits for none. */
  summaryPending: string | null;
  actions: RowActions;
}) {
  return (
    <>
      <td className="table__name">
        <button type="button" className="table__link" onClick={() => onOpen(item.path)}>
          <Icon name="doc" size={16} />
          <span className="table__title">{item.title}</span>
        </button>
      </td>
      <td className="inbox__kind">
        {kindOf(item)}
        <ImportStanding item={item} />
        {summaryPending !== null && (
          <span className="inbox__import inbox__summary-pending">
            Summary pending: {summaryPending}
          </span>
        )}
      </td>
      <td className="inbox__actions">
        {item.task === null ? (
          <NoteActions
            item={item}
            draft={draft}
            filing={choices.filing}
            createFiling={choices.createFiling}
            busy={busy}
            actions={actions}
          />
        ) : (
          <ClarifyTask
            item={item}
            task={item.task}
            draft={draft}
            choices={choices}
            busy={busy}
            actions={actions}
          />
        )}
        {refusal !== null && (
          <p className="inbox__refusal" role="alert">
            {refusal}
          </p>
        )}
      </td>
    </>
  );
});

/** "Meeting · Meetings": its type, and the folder of the Inbox it arrived in. */
function kindOf(item: InboxItem): string {
  const type = item.type === null ? 'Note' : humanizeKey(item.type);
  return item.arrivedIn === '' ? type : `${type} · ${item.arrivedIn}`;
}

/** What the meeting import made of a file, where it is still the Inbox's business. */
function ImportStanding({ item }: { item: InboxItem }) {
  if (item.importOutcome === 'pending') {
    return <span className="inbox__import">Waiting to be imported</span>;
  }
  if (item.importOutcome !== 'error') return null;
  return (
    <span className="inbox__import inbox__import--error">
      Not imported: {item.importError ?? 'it does not follow the meeting contract'}
    </span>
  );
}

/** A note that is not a task: filed at once, or — with no type of its own — made a task. */
function NoteActions({
  item,
  draft,
  filing,
  createFiling,
  busy,
  actions,
}: {
  item: InboxItem;
  /** Holds a project only from a picker a key armed, until Enter. */
  draft: InboxDraft;
  filing: readonly RelationChoice[];
  createFiling: CreateFiling | null;
  busy: boolean;
  actions: RowActions;
}) {
  return (
    <div className="inbox__clarify">
      {item.type === null && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy}
          onClick={() => actions.makeTask(item.path)}
        >
          Make task
        </button>
      )}
      <NotePicker
        label={`File ${item.title} under`}
        value={draft.project ?? ''}
        placeholder={filing.length === 0 ? 'No project or area yet' : 'File under…'}
        choices={filing}
        disabled={busy || (filing.length === 0 && createFiling === null)}
        onPick={(project) => actions.fileUnder(item.path, project)}
        createFiling={createFiling}
        field="project"
      />
    </div>
  );
}

/** A task's row: everything GTD's clarify step decides, written by Done in one save. */
function ClarifyTask({
  item,
  task,
  draft,
  choices,
  busy,
  actions,
}: {
  item: InboxItem;
  task: InboxTask;
  draft: InboxDraft;
  choices: RowChoices;
  busy: boolean;
  actions: RowActions;
}) {
  const pick = (picked: InboxDraft) => actions.pick(item.path, picked);
  const status = draft.status ?? task.status ?? '';
  // What the vault's Task type declares, and what the task says now so the row can show it.
  const offered = GTD_STATUSES.filter(
    (each) => choices.statuses.includes(each) || each === task.status,
  );
  return (
    <form
      className="inbox__clarify"
      aria-label={`Clarify ${item.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        actions.commit(item, draft);
      }}
    >
      <select
        className="inbox__file"
        aria-label={`Status of ${item.title}`}
        value={status}
        disabled={busy}
        onChange={(event) => {
          if (isGtdStatus(event.target.value)) pick({ status: event.target.value });
        }}
      >
        {status === '' && <option value="">Status…</option>}
        {offered.map((each) => (
          <option key={each} value={each}>
            {GTD_STATUS_LABELS[each]}
          </option>
        ))}
      </select>
      {asksWhoItWaitsOn(task, draft) && (
        <NotePicker
          label={`Who ${item.title} waits on`}
          value={draft.waitingOn ?? task.waitingOn ?? ''}
          placeholder={task.waitingOnNames === '' ? 'Waiting on…' : task.waitingOnNames}
          choices={choices.people}
          disabled={busy}
          onPick={(waitingOn) => pick({ waitingOn })}
        />
      )}
      <NotePicker
        label={`File ${item.title} under`}
        value={draft.project ?? task.project ?? ''}
        placeholder={choices.filing.length === 0 ? 'No project or area yet' : 'Project or area…'}
        choices={choices.filing}
        disabled={busy || (choices.filing.length === 0 && choices.createFiling === null)}
        onPick={(project) => pick({ project })}
        createFiling={choices.createFiling}
        field="project"
      />
      <DayField
        label="Defer"
        name={`Defer ${item.title} until`}
        value={draft.defer ?? task.defer ?? ''}
        disabled={busy}
        onPick={(defer) => pick({ defer })}
        field="defer"
      />
      <DayField
        label="Due"
        name={`${item.title} is due`}
        value={draft.due ?? task.due ?? ''}
        disabled={busy}
        onPick={(due) => pick({ due })}
      />
      <button
        type="submit"
        className="btn btn--primary btn--sm"
        disabled={busy || clarificationOf(task, draft) === null}
      >
        Save
      </button>
    </form>
  );
}

/**
 * A picker of notes, valued by path: a field that suggests them as you type
 * (#465), showing the title of the one it holds while nothing is typed. A
 * pick is always deliberate — ↵, Tab or a click — never typeahead passing
 * over an option, as it was in the select this replaces.
 */
function NotePicker({
  label,
  value,
  placeholder,
  choices,
  disabled,
  onPick,
  createFiling = null,
  field,
}: {
  label: string;
  value: string;
  placeholder: string;
  choices: readonly RelationChoice[];
  disabled: boolean;
  onPick: (path: VaultPath) => void;
  /** Makes a project or an area of what was typed, then picks it (#465). */
  createFiling?: CreateFiling | null;
  /** Which picker a triage key opens (P): named so the key finds it. */
  field?: 'project';
}) {
  const current = choices.find((choice) => choice.path === value)?.title;
  return (
    <LinkCombobox
      label={label}
      className="inbox__file"
      placeholder={placeholder}
      {...(current !== undefined && { current })}
      choices={choices}
      disabled={disabled}
      onPick={(choice) => onPick(createVaultPath(choice.path))}
      {...(createFiling !== null && {
        creates: FILED_UNDER_TYPES,
        onCreate: (request: CreateLink) => createFiling(request).then(onPick),
      })}
      {...(field !== undefined && { field })}
    />
  );
}

function DayField({
  label,
  name,
  value,
  disabled,
  onPick,
  field,
}: {
  label: string;
  /** What a screen reader calls it, naming the task. */
  name: string;
  value: string;
  disabled: boolean;
  onPick: (day: string) => void;
  /** Which picker a triage key opens (T): named so the key finds it. */
  field?: 'defer';
}) {
  return (
    <label className="inbox__day">
      <span aria-hidden="true">{label}</span>
      <input
        type="date"
        className="inbox__file"
        aria-label={name}
        {...(field !== undefined && { 'data-field': field })}
        value={value}
        disabled={disabled}
        onChange={(event) => onPick(event.target.value)}
      />
    </label>
  );
}

const NO_CREATE: CreateFiling = () => Promise.reject(new Error('Nothing can be made from here.'));
