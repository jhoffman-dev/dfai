import { useMemo, useRef, type ReactNode } from 'react';
import {
  columnSummary,
  countLabel,
  groupLines,
  optionLabel,
  type BoardRow,
  type GroupLine,
  type PropertyKind,
  type RowGroup,
} from '@dfai/domain';
import { Icon } from './icon.tsx';
import { ROW_STOP, useRowFocus } from './row-focus.ts';
import { StatusPill } from './status-pill.tsx';
import { useRangeVirtualizer } from './range-virtualizer.ts';

/** A table's groups, which are folded shut, and what can be done to them. */
export interface TableGrouping {
  readonly groups: readonly RowGroup[];
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  /** Adds a note inside a group — it and the groups it is in. Given, each innermost group ends with "+ New". */
  readonly onNew?: ((chain: readonly RowGroup[]) => void) | undefined;
}

/**
 * Where a line sits among the lines the virtualiser places, and the ref that
 * measures it: a row whose cell wraps is taller than the estimate, and lines
 * placed by the estimate alone would drift over one another.
 */
export interface LinePlace {
  readonly index: number;
  readonly measure: (element: Element | null) => void;
}

/** A shown column: its key, and its kind, which says whether its header summary adds up. */
export interface SummaryColumn {
  readonly key: string;
  readonly kind?: PropertyKind | undefined;
}

/**
 * Heights the virtualiser places lines by, matching the stylesheet's
 * (Table.dc.html: 32px group rows, 34px rows, 30px "+ New");
 * `e2e/row-estimates.spec.ts` pins them to what WebKit draws.
 */
const LINE_HEIGHT: Readonly<Record<GroupLine['kind'], number>> = { group: 32, row: 34, new: 30 };

/**
 * Rows drawn beyond the window's edge, so a scroll has rows ready. 34px rows
 * fit more in a window than 44px ones did, so fewer are drawn past it to keep
 * the drawn count — and the work budget "Open the 420-row table" — level.
 */
export const OVERSCAN = 8;

/** The height a table row is placed by until it is measured. */
export const ROW_ESTIMATE = LINE_HEIGHT.row;

/**
 * A body line's `aria-rowindex`: the heading row is the table's first. A
 * virtualised table leaves most of its rows out of the page, so each row
 * says where it sits, and the table how many rows it has (`aria-rowcount`).
 */
export const ariaRowIndex = (index: number): number => index + 2;

/** The scroller's size before it is measured: jsdom reports a zero-height one, which would draw no lines at all. */
export const SCROLLER_ESTIMATE = { width: 960, height: 880 };

/**
 * How many rows a window of the scroller holds under its sticky header, less
 * one, so a Page Down lands on a row already wholly in view.
 */
export function rowsPerPage(scroller: HTMLElement | null): number {
  const height = scroller?.clientHeight || SCROLLER_ESTIMATE.height;
  const header = scroller?.querySelector('thead')?.clientHeight ?? 0;
  return Math.max(1, Math.floor((height - header) / ROW_ESTIMATE) - 1);
}

/**
 * The lines a grouped table draws, its header rows among them: worked out by
 * the table, which says how many rows it has, and handed to `GroupedRows`.
 */
export function useGroupLines(grouping: TableGrouping | undefined): readonly GroupLine[] {
  const groups = grouping?.groups;
  const collapsed = grouping?.collapsed;
  const adds = grouping?.onNew !== undefined;
  // Without a way to add a note there is no "+ New" line to make room for.
  return useMemo(
    () =>
      groups === undefined || collapsed === undefined
        ? []
        : groupLines({ groups, collapsed }).filter((line) => adds || line.kind !== 'new'),
    [groups, collapsed, adds],
  );
}

/**
 * The rows' paths in the order a grouped table shows them, group by group; a
 * folded group's rows are not shown, so are not among them.
 */
export function rowOrder(lines: readonly GroupLine[]): readonly string[] {
  return lines.flatMap((line) => (line.kind === 'row' ? [line.row.path] : []));
}

/**
 * A table's rows in their groups and sub-groups, as Coda draws them: each
 * group a full-width header row — disclosure arrow, the value (a pill for a
 * select), how many rows, and a summary under every column that adds up — with
 * its sub-groups one step in, and "+ New" at the foot of each innermost group.
 *
 * Virtualised: only the lines near the scroller's window are in the page, and
 * a folded group is a header and nothing else. Up, Down, Home and End move
 * between the rows' names and the headers, as the flat table's do, skipping
 * "+ New"; Enter and Space fold a header, as a button does.
 */
export function GroupedRows({
  grouping,
  lines,
  columns,
  lead,
  noun,
  newLabel,
  renderRow,
  scroller,
}: {
  grouping: TableGrouping;
  /** The lines `useGroupLines` worked out for `grouping`. */
  lines: readonly GroupLine[];
  /** The shown columns in order, the name first. */
  columns: readonly SummaryColumn[];
  /** Cells each row leads with before its name: a choose box, a done box. */
  lead: number;
  /** The type's name, for "3 tasks". */
  noun: string;
  /** "New task". */
  newLabel: string;
  renderRow: (row: BoardRow, place: LinePlace) => ReactNode;
  /** The element the table scrolls in; null until it is in the page. */
  scroller: HTMLElement | null;
}) {
  const { onToggle, onNew } = grouping;
  const body = useRef<HTMLTableSectionElement>(null);
  const virtualizer = useRangeVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller,
    estimateSize: (index) => LINE_HEIGHT[lines[index]?.kind ?? 'row'],
    overscan: OVERSCAN,
    initialRect: SCROLLER_ESTIMATE,
  });
  const onKeyDown = useRowFocus({
    body,
    count: lines.length,
    stopKey: (index) => stopKeyOf(lines[index]),
    pageSize: () => rowsPerPage(scroller),
    scrollTo: (index) => virtualizer.scrollToIndex(index),
  });

  const items = virtualizer.getVirtualItems();
  const before = items[0]?.start ?? 0;
  const after = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const width = lead + columns.length;

  return (
    <tbody ref={body} onKeyDown={onKeyDown}>
      {before > 0 && <Spacer height={before} width={width} />}
      {items.map((item) => {
        const line = lines[item.index];
        if (line === undefined) return null;
        const { index } = item;
        const measure = virtualizer.measureElement;
        if (line.kind === 'row') return renderRow(line.row, { index, measure });
        if (line.kind === 'new') {
          return (
            onNew !== undefined && (
              <NewLine
                key={`new${line.chain.at(-1)?.id ?? ''}`}
                line={line}
                index={index}
                measure={measure}
                width={width}
                label={newLabel}
                onNew={onNew}
              />
            )
          );
        }
        return (
          <GroupHeader
            key={line.group.id}
            line={line}
            index={index}
            measure={measure}
            columns={columns}
            lead={lead}
            noun={noun}
            onToggle={() => onToggle(line.group.id)}
          />
        );
      })}
      {after > 0 && <Spacer height={after} width={width} />}
    </tbody>
  );
}

/**
 * The key a line's stop goes by, whatever moves around it: a header by its
 * group, a row by its note. "+ New" holds no stop.
 */
function stopKeyOf(line: GroupLine | undefined): string | null {
  if (line?.kind === 'group') return `group:${line.group.id}`;
  if (line?.kind === 'row') return `row:${line.row.path}`;
  return null;
}

/** Room for the lines scrolled out of the page, so the scrollbar stays true. */
export function Spacer({ height, width }: { height: number; width: number }) {
  return (
    <tr aria-hidden="true" className="table__spacer">
      <td colSpan={width} style={{ height }} />
    </tr>
  );
}

function GroupHeader({
  line,
  index,
  measure,
  columns,
  lead,
  noun,
  onToggle,
}: {
  line: Extract<GroupLine, { kind: 'group' }>;
  index: number;
  measure: LinePlace['measure'];
  columns: readonly SummaryColumn[];
  lead: number;
  noun: string;
  onToggle: () => void;
}) {
  const { group, depth, collapsed } = line;
  const count = group.rows.length;
  return (
    <tr
      className={`table__group table__group--depth-${depth}`}
      ref={measure}
      data-index={index}
      aria-rowindex={ariaRowIndex(index)}
    >
      <td colSpan={lead + 1} className="table__group-cell">
        <button
          {...ROW_STOP}
          type="button"
          className="table__group-toggle"
          aria-expanded={!collapsed}
          data-depth={depth}
          onClick={onToggle}
        >
          <Icon
            name="chevron"
            size={14}
            className={collapsed ? 'table__fold table__fold--shut' : 'table__fold'}
          />
          {group.tone !== null && group.value !== null ? (
            <>
              <StatusPill value={group.label} tone={group.tone} variant="dot" decorative />
              <span className="table__group-label">{optionLabel(group.label)}</span>
            </>
          ) : (
            <span className="table__group-label">{group.label}</span>
          )}
          <span className="table__group-count" aria-label={countLabel({ count, noun })}>
            {count}
          </span>
        </button>
      </td>
      {columns.slice(1).map((column) => {
        const summary = columnSummary({ rows: group.rows, key: column.key, kind: column.kind });
        return (
          <td key={column.key} className="table__summary">
            {summary !== null && (
              <span className="table__text" title={summary}>
                {summary}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function NewLine({
  line,
  index,
  measure,
  width,
  label,
  onNew,
}: {
  line: Extract<GroupLine, { kind: 'new' }>;
  index: number;
  measure: LinePlace['measure'];
  width: number;
  label: string;
  onNew: (chain: readonly RowGroup[]) => void;
}) {
  const where = line.chain.map((group) => group.label).join(' · ');
  return (
    <tr
      className="table__group-new"
      ref={measure}
      data-index={index}
      aria-rowindex={ariaRowIndex(index)}
    >
      <td colSpan={width}>
        <button
          type="button"
          className="table__new table__new--group"
          data-depth={line.depth}
          aria-label={`${label} in ${where}`}
          onClick={() => onNew(line.chain)}
        >
          <Icon name="plus" size={14} />
          {label}
        </button>
      </td>
    </tr>
  );
}
