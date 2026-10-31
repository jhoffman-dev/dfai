import { createVaultPath, pageCrumb, type VaultPath } from '@dfai/domain';
import {
  AtlasQueryPanel,
  HiddenTitle,
  PageBar,
  QueryPage,
  SegmentedControl,
  type OverlaySlots,
  type PageHistory,
} from '@dfai/ui';
import type { QueryLanguage, useQueryPage } from './use-query-page.ts';

const PAGE = { kind: 'query' } as const;

const LANGUAGES: readonly { value: QueryLanguage; label: string }[] = [
  { value: 'atlas', label: 'DFAI query' },
  { value: 'sql', label: 'SQL' },
];

/**
 * The query page as a page: the bar and head every page has, then the editor,
 * its result and the schema. It takes the place of the panes, as a type does.
 */
export function QueryScreen({
  query,
  onOpenNote,
  onShowSidebar,
  history,
  popups,
}: {
  query: ReturnType<typeof useQueryPage>;
  onOpenNote: (path: VaultPath) => void;
  onShowSidebar?: () => void;
  history?: PageHistory;
  popups?: OverlaySlots;
}) {
  const hasPaths = query.result?.columns.includes('path') === true;
  return (
    <>
      <PageBar
        crumb={pageCrumb(PAGE, null)}
        name="Query"
        {...(onShowSidebar !== undefined && { onShowSidebar })}
        {...(history !== undefined && { history })}
      />
      <div className="panel__body">
        <article className="page page--wide query-screen" aria-label="Query">
          <HiddenTitle>Query</HiddenTitle>
          <div className="query__language">
            <SegmentedControl
              label="Query language"
              options={LANGUAGES}
              value={query.language}
              onChange={query.setLanguage}
            />
          </div>
          {query.language === 'atlas' ? (
            <AtlasQueryPanel {...query.atlas} {...(popups !== undefined && { popups })} />
          ) : (
            <QueryPage
              sql={query.sql}
              onSqlChange={query.setSql}
              onRun={query.run}
              running={query.running}
              result={query.result}
              error={query.error}
              sorts={query.sorts}
              onToggleSort={query.toggleSort}
              // A row names a note only when the query returned its path.
              onOpenNote={(path) => {
                if (hasPaths) onOpenNote(createVaultPath(path));
              }}
              schema={query.schema}
              save={{ layouts: query.layouts, error: query.saveError, onSave: query.saveAsView }}
              dashboards={{
                choices: query.dashboardChoices,
                shows: query.shows,
                notice: query.dashboardNotice,
                onAdd: query.addToDashboard,
              }}
              {...(popups !== undefined && { popups })}
            />
          )}
        </article>
      </div>
    </>
  );
}
