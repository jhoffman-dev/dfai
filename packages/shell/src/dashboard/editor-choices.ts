import {
  filterChoices,
  NO_CHOICE_SOURCES,
  type ObjectType,
  type SavedViewSummary,
  type WidgetDraft,
} from '@dfai/domain';
import type { EditorChoice, ViewField } from '@dfai/ui';

/**
 * What the widget editor's lists offer, read from the vault's types: the types
 * themselves, the saved views to start from, and — for the draft's type — what
 * it can be filtered and grouped by, and the values a grouping can call out.
 */
export function editorChoices({
  draft,
  types,
  savedViews,
}: {
  draft: WidgetDraft;
  types: readonly ObjectType[];
  savedViews: readonly SavedViewSummary[];
}): {
  types: EditorChoice[];
  views: EditorChoice[];
  fields: ViewField[];
  groupings: EditorChoice[];
  groupValues: string[];
} {
  const type = types.find((candidate) => candidate.name === draft.type);
  const properties = type?.properties ?? [];
  const grouping = properties.find((def) => def.key === draft.groupBy);
  // A grouping the type does not declare still reads, so it is still offered.
  const undeclared = draft.groupBy !== '' && grouping === undefined;
  return {
    types: types.map((candidate) => ({ value: candidate.name, label: candidate.label })),
    views: savedViews.map((view) => ({ value: view.path, label: view.title })),
    fields: [
      { key: 'title', label: 'Name' },
      ...properties
        .filter((def) => def.key !== 'title')
        .map((def) => ({
          key: def.key,
          label: def.label,
          kind: def.kind,
          // What the type itself declares; a widget's sheet reads no notes or tags.
          choices: filterChoices(def, NO_CHOICE_SOURCES),
        })),
    ],
    groupings: [
      ...properties.map((def) => ({ value: def.key, label: def.label })),
      ...(undeclared ? [{ value: draft.groupBy, label: draft.groupBy }] : []),
    ],
    groupValues: [...(grouping?.options ?? [])],
  };
}
