import {
  isDashboard,
  isDatasource,
  isSavedView,
  isTemplateNote,
  parseQueryView,
  queryViewLayout,
  noteTitle,
  pageCrumb,
  pageTitle,
  parseViewDisplay,
  type PageKind,
} from '@dfai/domain';
import type { OpenNote } from '@dfai/application';
import type { PageHeading } from '@dfai/ui';

const DESCRIPTION_KEY = 'description';

/**
 * How a pane's page is headed: which kind of page it is, and so where it sits
 * in the breadcrumb and what its title is. The rules are the domain's; this
 * only gathers what they are asked about.
 */
export function pageHeading({
  note,
  typeName,
  sql,
}: {
  note: OpenNote;
  /** The note's own type; null for a view or a source, whose `type` names other notes. */
  typeName: string | null;
  /** The SQL behind a view's rows, once it has run. */
  sql: string | null;
}): PageHeading {
  // A template wears what it makes — `atlas: dashboard`, a view's keys — and
  // is still only a template: its path is asked first.
  const page: PageKind = isTemplateNote(note.path)
    ? { kind: 'template', typeName }
    : pageKind(note.properties, typeName);
  const description = note.properties[DESCRIPTION_KEY];
  return {
    kind: page.kind === 'type' || page.kind === 'query' ? 'note' : page.kind,
    crumb: pageCrumb(page, note.path),
    title: pageTitle({ fileTitle: noteTitle(note.path), properties: note.properties }),
    description: typeof description === 'string' ? description : null,
    path: note.path,
    sql: page.kind === 'view' ? sql : null,
  };
}

/** A source is asked about first: it has a body of its own, like a view, but is neither. */
function pageKind(
  properties: Readonly<Record<string, unknown>>,
  typeName: string | null,
): PageKind {
  if (isDatasource(properties)) return { kind: 'source' };
  if (isDashboard(properties)) return { kind: 'dashboard' };
  // A query view keeps its layout without the keys a type's board needs.
  if (parseQueryView(properties) !== null)
    return { kind: 'view', layout: queryViewLayout(properties) };
  if (isSavedView(properties)) return { kind: 'view', layout: parseViewDisplay(properties).layout };
  return { kind: 'note', typeName };
}
