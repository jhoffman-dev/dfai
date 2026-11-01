import { useCallback, useMemo, useState } from 'react';
import {
  layoutLabel,
  queryViewFrontmatter,
  queryViewSaveProblem,
  queryWidgetDraft,
  QUERY_VIEW_LAYOUTS,
  type SidebarEntry,
  type VaultPath,
  type ViewLayout,
} from '@dfai/domain';
import { dashboardChange, ViewRefusedError, writeViewNote } from '@dfai/application';
import type { AddQueryToDashboard, Choice, SaveQuery } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { errorMessage } from './error-message.ts';
import type { QueryPagePorts } from './use-query-page.ts';
import { writeNoteProperties } from './use-view-writes.ts';

/** Table, board and list: the layouts a query's groups can be drawn in. */
export const QUERY_LAYOUT_CHOICES: readonly Choice<ViewLayout>[] = QUERY_VIEW_LAYOUTS.map(
  (layout) => ({ value: layout, label: layoutLabel(layout) }),
);

/**
 * The two ways to keep a DFAI query (P24-04): as a view note, which the
 * sidebar lists and the tabs offer, or as a widget on a dashboard. Both keep
 * the text exactly as it is written, never a reprint of it.
 */
export function useQueryKeeping({
  ports,
  text,
  viewPaths,
  dashboards,
  onSavedView,
  onChanged,
}: {
  ports: QueryPagePorts;
  text: string;
  viewPaths: readonly string[];
  dashboards: readonly SidebarEntry[];
  onSavedView: (path: VaultPath) => void;
  onChanged: () => void;
}): { save: SaveQuery; dashboards: AddQueryToDashboard } {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { fs, markdown, editors, activity } = ports;

  const onSave = useCallback(
    ({ name, layout }: { name: string; layout: ViewLayout }) => {
      const problem = queryViewSaveProblem(text);
      if (problem !== null) {
        setSaveError(problem);
        return;
      }
      const frontmatter = queryViewFrontmatter({ query: text, layout });
      const named = { activity, write: 'view', path: null, refusal: ViewRefusedError } as const;
      withGiveUpRecorded(named, () =>
        writeViewNote({ fs, markdown, takenPaths: viewPaths, name, frontmatter }),
      )
        .then((path) => {
          setSaveError(null);
          onChanged();
          onSavedView(path);
        })
        .catch((cause: unknown) => setSaveError(errorMessage(cause)));
    },
    [fs, markdown, activity, text, viewPaths, onChanged, onSavedView],
  );

  const onAdd = useCallback(
    ({ path, title }: { path: string; title: string }) => {
      const values = dashboardChange({
        kind: 'add',
        draft: queryWidgetDraft({ query: text, title }),
      });
      withGiveUpRecorded({ activity, write: 'dashboard', path }, () =>
        writeNoteProperties({ editors, fs, markdown, path, values }),
      )
        .then(() => {
          setNotice('Added to the dashboard.');
          onChanged();
        })
        .catch((cause: unknown) => setNotice(errorMessage(cause)));
    },
    [editors, fs, markdown, activity, text, onChanged],
  );

  const choices = useMemo(
    () => dashboards.map((entry) => ({ value: entry.path, label: entry.title })),
    [dashboards],
  );

  return {
    save: { layouts: QUERY_LAYOUT_CHOICES, error: saveError, onSave },
    dashboards: { choices, notice, onAdd },
  };
}
