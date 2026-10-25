/**
 * A dashboard as a caller describes one (P32-05, `make_dashboard`): a name, a
 * line saying what it is for, and its widgets as a dashboard note's
 * `widgets:` lists them.
 *
 * Each widget is checked by the widget editor's own rules (`widgetProblems`,
 * whose last word is the dashboard's parser), so what is refused is refused
 * in the words the editor would use, and what passes always draws. What is
 * written is each widget as the editor would write it from scratch
 * (`entryFromDraft`): a key the editor does not know is not carried into
 * `.atlas`.
 */

import type { SpecProblem } from '../errors/spec-problem.ts';
import { hiddenCharacterProblem } from '../query/entry-name-characters.ts';
import { entryNameProblem } from '../query/new-view.ts';
import {
  DASHBOARD_MARKER,
  DASHBOARD_MARKER_VALUE,
  MAX_WIDGETS,
  WIDGET_KINDS,
  type WidgetKind,
} from './dashboard.ts';
import { widgetEntryShapeProblems } from './widget-entry-checks.ts';
import { draftFromEntry, entryFromDraft, widgetProblems } from './widget-draft.ts';

/** The longest `description` a dashboard is proposed with: a line, not a page. */
export const MAX_DASHBOARD_DESCRIPTION = 500;

/** A dashboard checked: its name, its line, and its widgets as they will be written. */
export interface DashboardSpec {
  readonly name: string;
  readonly description: string | null;
  readonly widgets: readonly Readonly<Record<string, unknown>>[];
}

export type DashboardSpecReading =
  | { readonly ok: true; readonly spec: DashboardSpec }
  | { readonly ok: false; readonly problems: readonly SpecProblem[] };

/**
 * The dashboard `value` describes, or everything wrong with it, each problem
 * at the field or widget it is about. `knownTypes` are the vault's types: a
 * widget counting a type the vault has not got is refused, as in the editor.
 */
export function checkDashboardSpec(
  value: Readonly<Record<string, unknown>>,
  { knownTypes }: { knownTypes: readonly string[] },
): DashboardSpecReading {
  const problems: SpecProblem[] = [];
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  const nameProblem =
    typeof value['name'] === 'string' || value['name'] === undefined
      ? (entryNameProblem(name, 'dashboard') ??
        hiddenCharacterProblem(String(value['name'] ?? ''), 'dashboard'))
      : 'name must be text.';
  if (nameProblem !== null) problems.push({ at: 'name', message: nameProblem });
  const description = descriptionOf(value['description'], problems);
  const widgets = widgetsOf(value['widgets'], knownTypes, problems);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, spec: { name, description, widgets } };
}

/** The frontmatter a checked dashboard is written with: the marker, its line and its widgets. */
export function dashboardFrontmatter(spec: DashboardSpec): Readonly<Record<string, unknown>> {
  return {
    [DASHBOARD_MARKER]: DASHBOARD_MARKER_VALUE,
    ...(spec.description !== null && { description: spec.description }),
    widgets: spec.widgets,
  };
}

function descriptionOf(raw: unknown, problems: SpecProblem[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    problems.push({ at: 'description', message: 'description must be text.' });
    return null;
  }
  const description = raw.trim();
  if (description.length > MAX_DASHBOARD_DESCRIPTION) {
    problems.push({
      at: 'description',
      message: `description must be at most ${MAX_DASHBOARD_DESCRIPTION} characters.`,
    });
  }
  return description === '' ? null : description;
}

function widgetsOf(
  raw: unknown,
  knownTypes: readonly string[],
  problems: SpecProblem[],
): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push({ at: 'widgets', message: 'A dashboard needs at least one widget.' });
    return [];
  }
  if (raw.length > MAX_WIDGETS) {
    problems.push({ at: 'widgets', message: `A dashboard holds at most ${MAX_WIDGETS} widgets.` });
    return [];
  }
  return raw.flatMap((entry: unknown, position) => {
    const at = `widgets[${position}]`;
    const found = widgetEntryProblems(entry, knownTypes);
    problems.push(...found.map((message) => ({ at, message })));
    return found.length === 0 ? [entryFromDraft(draftFromEntry(entry))] : [];
  });
}

/** What is wrong with one entry of `widgets:`, in the editor's words; none when it draws. */
function widgetEntryProblems(entry: unknown, knownTypes: readonly string[]): string[] {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return ['A widget is a set of keys and values.'];
  }
  const kind = String((entry as Record<string, unknown>)['kind'] ?? '').trim();
  // The editor's draft reads an unknown kind as a number tile; a caller is told instead.
  if (!WIDGET_KINDS.includes(kind as WidgetKind)) {
    return [`There is no widget kind called “${kind}”: use one of ${WIDGET_KINDS.join(', ')}.`];
  }
  const shape = widgetEntryShapeProblems(entry as Readonly<Record<string, unknown>>);
  if (shape.length > 0) return shape;
  return widgetProblems(draftFromEntry(entry), { knownTypes });
}
