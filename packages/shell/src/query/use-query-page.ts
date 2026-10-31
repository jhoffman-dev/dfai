import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  layoutLabel,
  normaliseSql,
  sortResultRows,
  sqlLayoutProblem,
  sqlShowProblem,
  sqlViewFrontmatter,
  sqlWidgetDraft,
  toggledSorts,
  SQL_SHOWS,
  SQL_VIEW_LAYOUTS,
  type QuerySort,
  type SchemaTable,
  type SidebarEntry,
  type ObjectType,
  type SqlShow,
  type VaultPath,
  type ViewLayout,
} from '@dfai/domain';
import {
  dashboardChange,
  loadSchema,
  runSql,
  writeViewNote,
  ViewRefusedError,
  type ActivityLog,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
  type ViewResult,
} from '@dfai/application';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import type { OpenEditors } from '../panes/open-editors.ts';
import { errorMessage } from './error-message.ts';
import { useAtlasQueryPage } from './use-atlas-query-page.ts';
import { writeNoteProperties } from './use-view-writes.ts';

const NO_SORTS: readonly QuerySort[] = [];

const SHOW_LABELS: Readonly<Record<SqlShow, string>> = {
  table: 'Table',
  number: 'Number (first cell)',
  bar: 'Bar chart (label, value)',
};

export interface QueryPagePorts {
  readonly index: IndexPort;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly editors: OpenEditors;
  /** Where a save the page gives up on is recorded. */
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
}

/** Which language the query page is asking in: a DFAI query, or SQL by hand. */
export type QueryLanguage = 'atlas' | 'sql';

/**
 * The query page: a DFAI query built or written (ADR-0019), or a SQL
 * statement; the last result; the index's schema; and the two ways to keep a
 * query — as a view, or as a widget on a dashboard.
 */
export function useQueryPage({
  ports,
  open,
  indexKey,
  viewPaths,
  dashboards,
  onSavedView,
  onChanged,
  types,
  notePaths,
  onOpenNote,
}: {
  ports: QueryPagePorts;
  /** Whether the page is showing; the schema is read when it opens. */
  open: boolean;
  indexKey: string;
  viewPaths: readonly string[];
  dashboards: readonly SidebarEntry[];
  onSavedView: (path: VaultPath) => void;
  onChanged: () => void;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  onOpenNote: (path: string) => void;
}) {
  const [language, setLanguage] = useState<QueryLanguage>('atlas');
  const atlas = useAtlasQueryPage({
    ports,
    types,
    notePaths,
    indexKey,
    viewPaths,
    dashboards,
    onSavedView,
    onChanged,
    onOpenNote,
  });
  const run = useRun(ports.index);
  const schema = useSchema({ index: ports.index, open, indexKey });
  const columns = run.result?.columns ?? [];
  const keeping = useKeeping({ ports, ran: run.ran, viewPaths, onSavedView, onChanged });

  return {
    language,
    setLanguage,
    atlas,
    ...run,
    schema,
    layouts: SQL_VIEW_LAYOUTS.map((layout) => ({
      value: layout,
      label: layoutLabel(layout),
      problem: sqlLayoutProblem(layout, columns),
    })),
    shows: SQL_SHOWS.map((show) => ({
      value: show,
      label: SHOW_LABELS[show],
      problem: sqlShowProblem(show, columns),
    })),
    dashboardChoices: dashboards.map((entry) => ({ value: entry.path, label: entry.title })),
    ...keeping,
  };
}

/** The statement, running it, and the sorted result of the last run. */
function useRun(index: IndexPort) {
  const [sql, setSql] = useState('');
  /** The statement the result came from, which is what is kept — not what has been typed since. */
  const [ran, setRan] = useState('');
  const [result, setResult] = useState<ViewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [sorts, setSorts] = useState<readonly QuerySort[]>(NO_SORTS);

  const runQuery = useCallback(() => {
    const statement = normaliseSql(sql);
    setRunning(true);
    runSql({ index, sql: statement })
      .then((found) => {
        setResult({ ...found, sql: statement });
        setRan(statement);
        setError(null);
        setSorts(NO_SORTS);
      })
      .catch((cause: unknown) => {
        setResult(null);
        setError(errorMessage(cause));
      })
      .finally(() => setRunning(false));
  }, [index, sql]);

  const sorted = useMemo(
    () => (result === null ? null : { ...result, rows: sortResultRows(result, sorts) }),
    [result, sorts],
  );

  return {
    sql,
    setSql,
    ran,
    run: runQuery,
    running,
    result: sorted,
    error,
    sorts,
    toggleSort: useCallback((column: string) => setSorts((was) => toggledSorts(was, column)), []),
  };
}

/** The index's tables and columns, read when the page opens and again when the index changes. */
function useSchema({
  index,
  open,
  indexKey,
}: {
  index: IndexPort;
  open: boolean;
  indexKey: string;
}): readonly SchemaTable[] | null {
  const [schema, setSchema] = useState<readonly SchemaTable[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadSchema({ index })
      .then((tables) => {
        if (!cancelled) setSchema(tables);
      })
      .catch(() => {
        // An index that cannot describe itself yet lists nothing; queries still run.
        if (!cancelled) setSchema([]);
      });
    return () => {
      cancelled = true;
    };
  }, [index, open, indexKey]);
  return schema;
}

/** Saving the last query that ran as a view, or adding it to a dashboard. */
function useKeeping({
  ports,
  ran,
  viewPaths,
  onSavedView,
  onChanged,
}: {
  ports: QueryPagePorts;
  ran: string;
  viewPaths: readonly string[];
  onSavedView: (path: VaultPath) => void;
  onChanged: () => void;
}) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dashboardNotice, setDashboardNotice] = useState<string | null>(null);
  const { fs, markdown, editors, activity } = ports;

  const saveAsView = useCallback(
    ({ name, layout }: { name: string; layout: ViewLayout }) => {
      const frontmatter = sqlViewFrontmatter({ sql: ran, layout });
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
    [fs, markdown, activity, ran, viewPaths, onChanged, onSavedView],
  );

  const addToDashboard = useCallback(
    ({ path, show, title }: { path: string; show: SqlShow; title: string }) => {
      const draft = sqlWidgetDraft({ sql: ran, show, title });
      const values = dashboardChange({ kind: 'add', draft });
      withGiveUpRecorded({ activity, write: 'dashboard', path }, () =>
        writeNoteProperties({ editors, fs, markdown, path, values }),
      )
        .then(() => {
          setDashboardNotice('Added to the dashboard.');
          onChanged();
        })
        .catch((cause: unknown) => setDashboardNotice(errorMessage(cause)));
    },
    [editors, fs, markdown, activity, ran, onChanged],
  );

  return { saveAsView, saveError, addToDashboard, dashboardNotice };
}
