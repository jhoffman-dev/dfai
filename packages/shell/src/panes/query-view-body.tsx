import { AtlasQueryPanel, ViewSaveControls, ViewTabs, type OverlaySlots } from '@dfai/ui';
import type { QueryViewState } from '../query/use-query-view.ts';

/**
 * A saved DFAI query as a page (P24-04): the other saved queries as tabs,
 * then the query and its answer. While the query or its layout differs from
 * the file, the unsaved-changes notice is a strip above the query, where
 * `ViewToolbar` puts it — not a band inside the layout row (#341).
 */
export function QueryViewBody({
  view,
  onOpenView,
  popups,
}: {
  view: QueryViewState;
  onOpenView: (path: string) => void;
  popups?: OverlaySlots;
}) {
  return (
    <div className="query-view">
      <div className="view-toolbar">
        <ViewTabs tabs={view.tabs} onOpenView={onOpenView} />
      </div>
      {view.edited && (
        <ViewSaveControls
          suggestedName={view.suggestedName}
          error={view.saveError}
          onSave={view.save}
          onSaveAs={view.saveAs}
          onReset={view.reset}
          slot={popups?.('save-as-view')}
        />
      )}
      <AtlasQueryPanel {...view.panel} {...(popups !== undefined && { popups })} />
    </div>
  );
}
