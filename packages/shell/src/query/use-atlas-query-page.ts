import { useEffect, useRef, useState } from 'react';
import {
  blankBuilder,
  printAtlasQuery,
  queryFromBuilder,
  type ObjectType,
  type SidebarEntry,
  type VaultPath,
  type ViewLayout,
} from '@dfai/domain';
import { useNoteNames, type AtlasQueryPanelProps } from '@dfai/ui';
import { resultFor, useAtlasQuery } from './use-atlas-query.ts';
import { useQueryChoices } from './use-query-choices.ts';
import { QUERY_LAYOUT_CHOICES, useQueryKeeping } from './use-query-keeping.ts';
import type { QueryPagePorts } from './use-query-page.ts';

/**
 * A new DFAI query on the query page (P24-02): it starts as every note of
 * the vault's first type, in the builder, and can be saved as a view or added
 * to a dashboard. The panel's props, less the open state of its popovers.
 */
export function useAtlasQueryPage({
  ports,
  types,
  notePaths,
  indexKey,
  viewPaths,
  dashboards,
  onSavedView,
  onChanged,
  onOpenNote,
}: {
  ports: QueryPagePorts;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  indexKey: string;
  viewPaths: readonly string[];
  dashboards: readonly SidebarEntry[];
  onSavedView: (path: VaultPath) => void;
  onChanged: () => void;
  onOpenNote: (path: string) => void;
}): Omit<AtlasQueryPanelProps, 'popups'> {
  const editor = useAtlasQuery({ initialText: '', index: ports.index, types, notePaths, indexKey });
  const [layout, setLayout] = useState<ViewLayout>('table');
  const choices = useQueryChoices({
    index: ports.index,
    types,
    fields: editor.fields,
    notePaths,
    indexKey,
  });
  const keeping = useQueryKeeping({
    ports,
    text: editor.text,
    viewPaths,
    dashboards,
    onSavedView,
    onChanged,
  });
  const names = useNoteNames();

  // Nothing to ask until the vault's types are known; then, once, every note of
  // the first. Once only: clearing the text to write another must stay clear.
  const first = types[0]?.name;
  const seeded = useRef(false);
  const { load } = editor;
  useEffect(() => {
    if (seeded.current || first === undefined) return;
    seeded.current = true;
    load(printAtlasQuery(queryFromBuilder(blankBuilder(first))));
  }, [first, load]);

  const result = resultFor({ answer: editor.answer, layout, names });
  return {
    composer: {
      mode: editor.mode,
      onMode: editor.setMode,
      text: editor.text,
      onTextChange: editor.setText,
      problem: editor.problem,
      onRun: editor.rerun,
      builder: editor.builder,
      onBuilderChange: editor.setBuilder,
      textOnly: editor.textOnly,
      choices: {
        types: choices.typeChoices,
        fields: editor.fields,
        valueChoices: choices.valueChoices,
      },
    },
    layout,
    layouts: QUERY_LAYOUT_CHOICES,
    onLayout: setLayout,
    result:
      result === null
        ? null
        : { ...result, collapsed: editor.collapsed, onToggleGroup: editor.toggleGroup, onOpenNote },
    truncated: editor.answer?.result.truncated ?? false,
    error: editor.error,
    save: keeping.save,
    dashboards: keeping.dashboards,
  };
}
