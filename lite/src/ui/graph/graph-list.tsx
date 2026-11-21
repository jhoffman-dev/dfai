import { useMemo } from 'react';
import type { GraphNode, VaultGraph } from '../../domain/index/index.ts';

/**
 * The same graph as text, for the keyboard and a screen reader: every note in
 * the picture, then what it links to and what links to it. Each note is a
 * button, so the graph can be walked with Tab and opened with Enter.
 */
export function GraphList({
  graph,
  activePath,
  onOpenNote,
}: {
  graph: VaultGraph;
  activePath: string | null;
  onOpenNote: (path: string) => void;
}) {
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const links = useMemo(() => linksByNode(graph), [graph]);
  if (graph.nodes.length === 0) return <p className="graph__empty">No notes to show.</p>;

  const entry = (node: GraphNode | undefined, way: string) => {
    if (node === undefined) return null;
    return (
      <li key={`${way}:${node.id}`}>
        {node.kind === 'note' ? (
          <button type="button" className="graph__list-link" onClick={() => onOpenNote(node.id)}>
            <span className="graph__list-way">{way}</span> {node.title}
          </button>
        ) : (
          <span className="graph__list-link graph__list-link--ghost">
            <span className="graph__list-way">{way}</span> {node.title} (no note yet)
          </span>
        )}
      </li>
    );
  };

  return (
    <ul className="graph__list" aria-label="Notes in the graph">
      {graph.nodes
        .filter((node) => node.kind === 'note')
        .map((node) => {
          const { out, into } = links.get(node.id) ?? { out: [], into: [] };
          return (
            <li key={node.id} className="graph__list-item">
              <button
                type="button"
                className="graph__list-note"
                aria-current={node.id === activePath ? 'page' : undefined}
                onClick={() => onOpenNote(node.id)}
              >
                {node.title}
              </button>
              {out.length + into.length > 0 && (
                <ul className="graph__list-links" aria-label={`Linked with ${node.title}`}>
                  {out.map((id) => entry(byId.get(id), 'Links to'))}
                  {into.map((id) => entry(byId.get(id), 'Linked from'))}
                </ul>
              )}
            </li>
          );
        })}
    </ul>
  );
}

function linksByNode(graph: VaultGraph): Map<string, { out: string[]; into: string[] }> {
  const links = new Map<string, { out: string[]; into: string[] }>();
  const of = (id: string) => {
    let found = links.get(id);
    if (found === undefined) {
      found = { out: [], into: [] };
      links.set(id, found);
    }
    return found;
  };
  for (const { source, target } of graph.edges) {
    of(source).out.push(target);
    of(target).into.push(source);
  }
  return links;
}
