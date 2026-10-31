import type { ComponentProps } from 'react';
import type { GraphScope } from '@dfai/domain';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { graphPage } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';

const GraphPage = graphPage.Component;

/**
 * What the graph page needs from the window: the vault's graph as the
 * window reads it (`useVaultGraph`), which is also what names every
 * relation, so it stays the window's one read.
 */
export interface GraphWiring {
  readonly state: ComponentProps<typeof GraphPage>['state'];
}

/** The graph as a tab (tab-model.md, PR B), on the scope its place names. */
export function GraphContainer({
  wiring,
  chrome,
  scope,
}: PageContainerProps & { scope: GraphScope }) {
  const { pages, pane } = wiring;
  return (
    <LoadedLater chrome={chrome}>
      <GraphPage
        state={pages.graph.state}
        types={pane.types}
        scope={scope}
        onScopeChange={(next) => pages.openPage({ kind: 'graph', scope: next })}
        onOpen={(path, { split }) => pages.openNote(path, split ? 'split' : 'here')}
        {...chrome}
      />
    </LoadedLater>
  );
}
