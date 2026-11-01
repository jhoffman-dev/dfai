import { memo, type ReactNode } from 'react';
import type { PagePlace, Tab, TabId } from '@dfai/domain';
import { ActivityContainer } from '../activity/activity-container.tsx';
import { AskContainer } from '../ask/ask-container.tsx';
import { ArchiveContainer } from '../archive/archive-container.tsx';
import { AutomationsContainer } from '../automations/automations-container.tsx';
import { GraphContainer } from '../graph/graph-container.tsx';
import { InboxContainer } from '../inbox/inbox-container.tsx';
import type { PageChrome } from '../page-frame-fallback.tsx';
import { QueryContainer } from '../query/query-container.tsx';
import { ReviewContainer } from '../review/review-container.tsx';
import { TagsContainer } from '../tags/tags-container.tsx';
import { TemplatesContainer } from '../templates/templates-container.tsx';
import { SkillsContainer } from '../skills/skills-container.tsx';
import { TermsContainer } from '../terms/terms-container.tsx';
import { HighlightsContainer } from '../research/highlights-container.tsx';
import { LibraryContainer } from '../research/library-container.tsx';
import { TodayContainer } from '../today/today-container.tsx';
import { TypeContainer } from '../types/type-container.tsx';
import { DocumentContainer } from '../reader/document-container.tsx';
import { samePageWiring, type PageWiringContext } from './page-wiring.ts';
import { useTabPageHistory } from './tab-history.ts';
import { useIsFirstShownPane } from './workspace-store.ts';
import { sameWiringParts, type WorkspaceWiring } from './workspace-wiring.tsx';

/**
 * A tab on a page — Today, the Inbox, a type's table — drawn by the page's
 * own container, which reads the page's hooks (tab-model.md, PR B), with
 * this tab's own Back and Forward. Drawn only while it is the shown tab: a
 * page keeps no editor to wait behind another tab.
 */
export const PageTab = memo(
  // Named as the export: what the render counts know the tab by.
  function PageTab(props: PageTabProps) {
    return usePageTab(props);
  },
  (before, after) =>
    before.pane === after.pane &&
    before.tab === after.tab &&
    before.place.kind === after.place.kind &&
    sameWiringParts(PAGE_TAB_WIRING, before.wiring, after.wiring) &&
    samePageWiring(after.place.kind, before.wiring.pages, after.wiring.pages),
);

interface PageTabProps {
  wiring: WorkspaceWiring;
  pane: number;
  tab: Tab;
  /** What the tab shows: derived from `tab`, so the same while it is. */
  place: PagePlace;
}

/**
 * The parts of the wiring every page's tab reads; its own kind's part is
 * compared apart. Any new part a page tab reads must be added here (#325).
 */
const PAGE_TAB_WIRING = [
  'pane',
  'store',
  'nameOf',
  'onShowSidebar',
  'overlays',
  'reveals',
] as const;

/** The tab drawn: a hook, since its hooks are the tab component's own. */
function usePageTab({ wiring, pane, tab, place }: PageTabProps) {
  const { store, nameOf, onShowSidebar, overlays, reveals } = wiring;
  const history = useTabPageHistory({ store, pane, id: tab.id, nameOf });
  // The way back to a hidden sidebar sits where it went: the top-left corner
  // of the first pane on screen (#658).
  const firstShown = useIsFirstShownPane(store, pane);
  const chrome: PageChrome = {
    history,
    ...(firstShown && onShowSidebar !== null && { onShowSidebar }),
  };
  const pages: PageWiringContext = { pages: wiring.pages, pane: wiring.pane, overlays, reveals };
  return (
    <div className="pane__tab">
      {containerFor({ place, wiring: pages, tabId: tab.id, chrome, pane })}
    </div>
  );
}

/** The page a place names, by its kind, in its container. */
function containerFor({
  place,
  pane,
  ...props
}: {
  place: PagePlace;
  /** The pane the tab is in: Ask takes the keys only when its own pane asked (#37). */
  pane: number;
  wiring: PageWiringContext;
  tabId: TabId;
  chrome: PageChrome;
}): ReactNode {
  switch (place.kind) {
    case 'graph':
      return <GraphContainer {...props} scope={place.scope} />;
    case 'type':
      return <TypeContainer {...props} name={place.name} />;
    case 'query':
      return <QueryContainer {...props} />;
    case 'tags':
      return <TagsContainer {...props} selected={place.tag} />;
    case 'archive':
      return <ArchiveContainer {...props} />;
    case 'inbox':
      return <InboxContainer {...props} />;
    case 'review':
      return <ReviewContainer {...props} />;
    case 'today':
      return <TodayContainer {...props} />;
    case 'automations':
      return <AutomationsContainer {...props} />;
    case 'activity':
      return <ActivityContainer {...props} />;
    case 'templates':
      return <TemplatesContainer {...props} />;
    case 'terms':
      return <TermsContainer {...props} />;
    case 'skills':
      return <SkillsContainer {...props} />;
    case 'library':
      return <LibraryContainer {...props} />;
    case 'highlights':
      return <HighlightsContainer {...props} />;
    case 'ask':
      return <AskContainer {...props} pane={pane} />;
    case 'document':
      return <DocumentContainer {...props} path={place.path} />;
  }
}
