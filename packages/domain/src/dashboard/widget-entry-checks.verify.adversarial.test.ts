/**
 * Verify pass on PR #549: the spec checker must pass every widget the editor
 * and the docs say is right, and its hidden-character check must not leave a
 * way to hide text in a name.
 */
import { describe, expect, it } from 'vitest';
import { checkDashboardSpec } from './dashboard-spec.ts';
import { WIDGET_KINDS } from './dashboard.ts';
import {
  entryFromDraft,
  newWidgetDraft,
  sqlWidgetDraft,
  queryWidgetDraft,
} from './widget-draft.ts';
import { checkViewSpec } from '../query/view-spec.ts';
import { parseObjectType } from '../types/property-def.ts';

const KNOWN = { knownTypes: ['task', 'project'] };
const board = (widgets: unknown[], name = 'Board') => ({ name, widgets });
const problemsOf = (reading: ReturnType<typeof checkDashboardSpec>) =>
  reading.ok ? [] : reading.problems;

/** The shipped vault's `.atlas/dashboards/Progress.md` widgets, as JSON. */
const PROGRESS_WIDGETS = [
  {
    title: 'Tasks',
    kind: 'hero',
    type: 'task',
    groupBy: 'phase',
    progress: { label: 'done', filters: [{ key: 'status', operator: 'is', value: 'done' }] },
    span: 4,
  },
  { title: 'Work per phase', kind: 'bar', type: 'task', groupBy: 'phase', span: 8 },
  { title: 'By status', kind: 'donut', type: 'task', groupBy: 'status', span: 5 },
  { title: 'Largest phases', kind: 'rank', type: 'task', groupBy: 'phase', limit: 4, span: 4 },
  {
    title: 'In flight',
    kind: 'number',
    type: 'task',
    filters: [{ key: 'status', operator: 'is', value: 'doing' }],
    icon: 'bolt',
    span: 3,
  },
];

describe('checkDashboardSpec passes what the editor and the docs write (verify-549)', () => {
  it('passes the shipped Progress dashboard', () => {
    expect(problemsOf(checkDashboardSpec(board(PROGRESS_WIDGETS), KNOWN))).toEqual([]);
  });

  it.each(WIDGET_KINDS.filter((kind) => kind !== 'sql' && kind !== 'query'))(
    'passes a fresh %s widget as the editor writes it',
    (kind) => {
      const draft = { ...newWidgetDraft({ kind, type: 'task' }), groupBy: 'status' };
      expect(problemsOf(checkDashboardSpec(board([entryFromDraft(draft)]), KNOWN))).toEqual([]);
    },
  );

  it('passes the SQL and DFAI query widgets "Add to dashboard" writes', () => {
    const widgets = [
      entryFromDraft(sqlWidgetDraft({ sql: 'SELECT 1', show: 'number', title: 'One' })),
      entryFromDraft(queryWidgetDraft({ query: 'FROM task', title: 'Tasks' })),
    ];
    expect(problemsOf(checkDashboardSpec(board(widgets), KNOWN))).toEqual([]);
  });

  it('passes a numeric highlight, as docs/dashboards.md documents (`a value such as 15`)', () => {
    const widget = { kind: 'bar', type: 'task', groupBy: 'phase', highlight: 15 };
    expect(problemsOf(checkDashboardSpec(board([widget]), KNOWN))).toEqual([]);
  });
});

describe('the hidden-character check leaves no way to hide text in a name (verify-549)', () => {
  const refused = (name: string) =>
    !checkDashboardSpec(board([{ kind: 'list', type: 'task' }], name), KNOWN).ok;

  it('refuses a name that is only a zero-width joiner', () => {
    expect(refused('‍')).toBe(true);
  });

  it('refuses a joiner between letters, where it joins no emoji', () => {
    expect(refused('Re‍port')).toBe(true);
  });

  it('refuses Unicode tag characters smuggling text after a visible name', () => {
    // "Board" followed by the invisible tag spelling of "hi".
    expect(refused('Board\u{E0068}\u{E0069}')).toBe(true);
  });

  it('refuses a view named with a lone joiner too', () => {
    const types = [parseObjectType({ name: 'task', label: 'task', properties: {} })];
    expect(checkViewSpec({ name: '‍', type: 'task', layout: 'table' }, { types }).ok).toBe(false);
  });
});
