import { useDeferredValue, useMemo, useState } from 'react';
import type { VaultGraph } from '../../domain/index/index.ts';
import { GraphCanvas } from './graph-canvas.tsx';
import { GraphList } from './graph-list.tsx';
import { scopeGraph, type GraphDepth } from './graph-scope.ts';
import './graph.css';

export interface GraphViewProps {
  readonly graph: VaultGraph;
  /** The note open now: highlighted, and the centre of the local graph. */
  readonly activePath: string | null;
  readonly onOpenNote: (path: string) => void;
}

type Showing = 'graph' | 'list';

/**
 * The graph page: how the vault's notes link — all of them, or those around
 * the open note — drawn as a force layout or listed, with a filter box.
 */
export function GraphView({ graph, activePath, onOpenNote }: GraphViewProps) {
  const [local, setLocal] = useState(false);
  const [depth, setDepth] = useState<GraphDepth>(1);
  const [query, setQuery] = useState('');
  const [showing, setShowing] = useState<Showing>('graph');
  // Typing in the filter stays instant; the narrowed graph follows a beat behind.
  const deferredQuery = useDeferredValue(query);
  const centre = local ? activePath : null;
  const scoped = useMemo(
    () => scopeGraph(graph, { centre, depth, query: deferredQuery }),
    [graph, centre, depth, deferredQuery],
  );
  const notes = scoped.graph.nodes.filter((node) => node.kind === 'note').length;

  return (
    <section className="graph" aria-label="Graph">
      <div className="graph__controls">
        <div className="graph__group" role="group" aria-label="Scope">
          <button type="button" aria-pressed={!local} onClick={() => setLocal(false)}>
            Whole vault
          </button>
          <button
            type="button"
            aria-pressed={local}
            disabled={activePath === null}
            title={activePath === null ? 'Open a note to see the notes around it' : undefined}
            onClick={() => setLocal(true)}
          >
            Local graph
          </button>
        </div>
        {local && (
          <label className="graph__depth">
            Depth
            <select
              value={depth}
              onChange={(event) => setDepth(event.target.value === '2' ? 2 : 1)}
            >
              <option value="1">1 step</option>
              <option value="2">2 steps</option>
            </select>
          </label>
        )}
        <input
          type="search"
          className="graph__filter"
          placeholder="Filter notes"
          aria-label="Filter notes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="graph__group" role="group" aria-label="Show as">
          <button
            type="button"
            aria-pressed={showing === 'graph'}
            onClick={() => setShowing('graph')}
          >
            Graph
          </button>
          <button
            type="button"
            aria-pressed={showing === 'list'}
            onClick={() => setShowing('list')}
          >
            List
          </button>
        </div>
        <span className="graph__count">
          {notes} {notes === 1 ? 'note' : 'notes'} · {scoped.graph.edges.length}{' '}
          {scoped.graph.edges.length === 1 ? 'link' : 'links'}
        </span>
      </div>
      {scoped.hidden > 0 && (
        <p className="graph__notice" role="status">
          Showing the {scoped.graph.nodes.length} most linked notes; {scoped.hidden} more are left
          out to keep the graph responsive. Filter or use the local graph to see them.
        </p>
      )}
      <GraphBody
        graph={scoped.graph}
        showing={showing}
        activePath={activePath}
        onOpenNote={onOpenNote}
      />
    </section>
  );
}

function GraphBody({
  graph,
  showing,
  activePath,
  onOpenNote,
}: GraphViewProps & { readonly showing: Showing }) {
  if (showing === 'list') {
    return <GraphList graph={graph} activePath={activePath} onOpenNote={onOpenNote} />;
  }
  if (graph.nodes.length === 0) return <p className="graph__empty">No notes match.</p>;
  return (
    <div className="graph__stage">
      <GraphCanvas graph={graph} activePath={activePath} onOpenNote={onOpenNote} />
    </div>
  );
}
