import { lazy, Suspense, useMemo } from 'react';
import { useApp } from '../services.ts';
import { useVault } from '../state/vault-store.ts';
import '../tags/tags.css';

// d3 loads with the graph, not with the first paint.
const GraphView = lazy(() => import('../graph/index.ts'));

/** The vault's links as a graph; clicking a note opens it. */
export function GraphPage({ activePath }: { activePath: string | null }) {
  const { services, actions } = useApp();
  const version = useVault((vault) => vault.version);
  const graph = useMemo(
    () => services.session.index.graph(),
    // `version` is the cue to ask the index again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, version],
  );
  return (
    <div className="graph-page">
      <h1 className="page-title">Graph</h1>
      <Suspense fallback={<p className="tags-empty">Loading the graph…</p>}>
        <GraphView graph={graph} activePath={activePath} onOpenNote={actions.openNote} />
      </Suspense>
    </div>
  );
}
