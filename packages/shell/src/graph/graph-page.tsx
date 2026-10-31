import { useMemo, useState } from 'react';
import {
  graphTypes,
  graphTypeTones,
  scopeGraph,
  DEFAULT_GRAPH_FILTER,
  type GraphDepth,
  type GraphFilter,
  type GraphScope,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import { pictureGraph } from '@dfai/application';
import type { PageHistory } from '@dfai/ui';
import { GraphView, type GraphContent, type OpenRequest } from '@dfai/ui/graph';
import type { VaultGraphState } from './use-vault-graph.ts';

/**
 * The graph page, loaded on first use: d3-force and the drawing come with it,
 * so a session that never opens the graph never downloads them.
 *
 * Holds the page's own choices — the filters — and hands everything else up:
 * the scope is the app's, since "Show in graph" sets it from a note's menu.
 */
export default function GraphPage({
  state,
  scope,
  types,
  onScopeChange,
  onOpen,
  onShowSidebar,
  history,
}: {
  state: VaultGraphState;
  scope: GraphScope;
  types: readonly ObjectType[];
  onScopeChange: (scope: GraphScope) => void;
  onOpen: (path: VaultPath, request: OpenRequest) => void;
  onShowSidebar?: () => void;
  history?: PageHistory;
}) {
  const [filter, setFilter] = useState<GraphFilter>(DEFAULT_GRAPH_FILTER);
  const graph = state.kind === 'ready' ? state.graph : null;
  // Tones from every type, so a type keeps its colour when system notes come and go;
  // chips only for types the notes in reach carry — a template's type is not the vault's.
  const tones = useMemo(() => graphTypeTones(graph === null ? [] : graphTypes(graph)), [graph]);
  const allTypes = useMemo(
    () =>
      graph === null
        ? []
        : graphTypes(
            scopeGraph(graph, {
              scope: { kind: 'vault' },
              filter: {
                ...DEFAULT_GRAPH_FILTER,
                hideSystem: filter.hideSystem,
                hideArchived: filter.hideArchived,
              },
            }),
          ),
    [graph, filter.hideSystem, filter.hideArchived],
  );
  const content = useMemo((): GraphContent => {
    if (state.kind !== 'ready') return state;
    return { kind: 'ready', ...pictureGraph(state.graph, { scope, filter }) };
  }, [state, scope, filter]);

  const labels = new Map(types.map((type) => [type.name, type.label]));
  const centre =
    scope.kind === 'note'
      ? {
          path: scope.path,
          depth: scope.depth,
          title: graph?.nodes.find((node) => node.path === scope.path)?.title ?? scope.path,
        }
      : null;

  return (
    <GraphView
      content={content}
      centre={centre}
      types={allTypes}
      typeLabel={(type) => (type === null ? 'No type' : (labels.get(type) ?? type))}
      tones={tones}
      filter={filter}
      onFilterChange={setFilter}
      onDepthChange={(depth: GraphDepth) => {
        if (scope.kind === 'note') onScopeChange({ ...scope, depth });
      }}
      onShowVault={() => onScopeChange({ kind: 'vault' })}
      onOpen={onOpen}
      {...(onShowSidebar !== undefined && { onShowSidebar })}
      {...(history !== undefined && { history })}
    />
  );
}
