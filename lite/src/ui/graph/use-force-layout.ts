import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { VaultGraph } from '../../domain/index/index.ts';
import { neighboursOf, nodeRadius } from './graph-scope.ts';

interface LaidNode extends SimulationNodeDatum {
  readonly id: string;
  readonly radius: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Ticks run before the first paint, so the graph opens settled rather than exploding outwards. */
const WARM_TICKS = 160;

/** The nodes and edges a layout depends on, as one string: the same shape gives the same key. */
function shapeOf(graph: VaultGraph): string {
  const nodes = graph.nodes.map((node) => node.id).sort();
  const edges = graph.edges.map((edge) => `${edge.source}\n${edge.target}`).sort();
  return JSON.stringify([nodes, edges]);
}

/**
 * Where each note sits, worked out by a d3-force simulation: links pull,
 * notes push apart, a gentle pull keeps the whole centred on the origin.
 *
 * The simulation is built again only when the graph's shape changes — never
 * on an ordinary render — and the nodes already placed are pinned while new
 * ones settle around them, so the picture does not jump. d3-force seeds its
 * own random source with a constant, so the same graph lays out the same way.
 */
export function useForceLayout(graph: VaultGraph) {
  const [positions, setPositions] = useState<ReadonlyMap<string, Point>>(new Map());
  const simulation = useRef<Simulation<LaidNode, SimulationLinkDatum<LaidNode>> | null>(null);
  const placed = useRef(new Map<string, Point>());
  const shape = useMemo(() => shapeOf(graph), [graph]);
  // Holding the graph by its shape: a rebuilt graph with the same notes and links keeps the layout.
  const [laidOut, setLaidOut] = useState({ shape, graph });
  if (laidOut.shape !== shape) setLaidOut({ shape, graph });

  useEffect(() => {
    const { graph: current } = laidOut;
    const degrees = neighboursOf(current.edges);
    const nodes: LaidNode[] = current.nodes.map((node) => {
      const at = placed.current.get(node.id);
      return {
        id: node.id,
        radius: nodeRadius(degrees.get(node.id)?.size ?? 0),
        ...(at === undefined ? {} : { x: at.x, y: at.y, fx: at.x, fy: at.y }),
      };
    });
    const links = current.edges.map((edge) => ({ source: edge.source, target: edge.target }));
    const running = forceSimulation(nodes)
      .force(
        'link',
        forceLink<LaidNode, SimulationLinkDatum<LaidNode>>(links)
          .id((node) => node.id)
          .distance(60),
      )
      .force('charge', forceManyBody<LaidNode>().strength(-140).distanceMax(420))
      .force(
        'collide',
        forceCollide<LaidNode>((node) => node.radius + 4),
      )
      .force('x', forceX<LaidNode>(0).strength(0.04))
      .force('y', forceY<LaidNode>(0).strength(0.04))
      .stop();
    running.tick(WARM_TICKS);
    for (const node of nodes) {
      node.fx = null;
      node.fy = null;
    }
    const publish = (): void => {
      const next = new Map(nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
      placed.current = next;
      setPositions(next);
    };
    publish();
    running.on('tick', publish);
    simulation.current = running;
    return () => {
      running.stop();
      simulation.current = null;
    };
  }, [laidOut]);

  /** Holds a note where it is dragged to, and lets the rest settle around it; null lets it go. */
  const drag = (id: string, to: Point | null): void => {
    const running = simulation.current;
    const node = running?.nodes().find((each) => each.id === id);
    if (running === null || node === undefined) return;
    node.fx = to?.x ?? null;
    node.fy = to?.y ?? null;
    if (to !== null) running.alphaTarget(0.25).restart();
    else running.alphaTarget(0);
  };

  return { positions, drag };
}
