import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { GraphNode, VaultGraph } from '../../domain/index/index.ts';
import { neighboursOf, nodeRadius } from './graph-scope.ts';
import { useForceLayout, type Point } from './use-force-layout.ts';

/** Pan and zoom: a translation in screen pixels and a scale. */
interface View {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
/** How far the pointer may move and still count as a click, not a drag. */
const CLICK_SLOP = 4;
/** Below this many notes every title is drawn; above it, only when zoomed in or pointed at. */
const ALWAYS_LABELLED = 40;

/**
 * The graph as a picture: notes as dots sized by how connected they are,
 * links as lines, link targets no note answers to as hollow ghosts. Drag the
 * ground to pan, the wheel to zoom, a note to move it; point at a note to
 * light its neighbours, click it to open it. Not keyboard-friendly by nature,
 * so the view offers the same graph as a list.
 */
export function GraphCanvas({
  graph,
  activePath,
  onOpenNote,
}: {
  graph: VaultGraph;
  activePath: string | null;
  onOpenNote: (path: string) => void;
}) {
  const { positions, drag } = useForceLayout(graph);
  // Null until the person pans or zooms: until then the whole graph is fitted to the stage.
  const [chosen, setView] = useState<View | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const surface = useRef<SVGSVGElement>(null);
  const size = useSize(surface);
  const view = chosen ?? fitView(positions, size);
  const neighbours = useMemo(() => neighboursOf(graph.edges), [graph.edges]);
  const lit = hovered === null ? null : new Set([hovered, ...(neighbours.get(hovered) ?? [])]);
  const labelAll = graph.nodes.length <= ALWAYS_LABELLED || view.k >= 1.4;

  const toGraph = (event: { clientX: number; clientY: number }): Point => {
    const box = surface.current?.getBoundingClientRect();
    const originX = (box?.left ?? 0) + (box?.width ?? 0) / 2;
    const originY = (box?.top ?? 0) + (box?.height ?? 0) / 2;
    return {
      x: (event.clientX - originX - view.x) / view.k,
      y: (event.clientY - originY - view.y) / view.k,
    };
  };

  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    const factor = Math.exp(-event.deltaY * 0.0015);
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
    const at = toGraph(event);
    // Zoom about the pointer: the point under it stays under it.
    setView({ k, x: view.x + at.x * (view.k - k), y: view.y + at.y * (view.k - k) });
  };

  const handlers = useGestures({ view, setView, toGraph, drag, onOpenNote });

  return (
    <svg
      ref={surface}
      className="graph__surface"
      viewBox={`${-size.width / 2} ${-size.height / 2} ${size.width} ${size.height}`}
      role="img"
      aria-label={`${graph.nodes.length} notes and ${graph.edges.length} links. The list view has them as text.`}
      onWheel={onWheel}
      onPointerDown={handlers.startPan}
      onPointerMove={handlers.move}
      onPointerUp={handlers.end}
      onPointerCancel={handlers.end}
    >
      <g className="graph__world" transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {graph.edges.map((edge) => {
          const from = positions.get(edge.source);
          const to = positions.get(edge.target);
          if (from === undefined || to === undefined) return null;
          const dim = hovered !== null && edge.source !== hovered && edge.target !== hovered;
          return (
            <line
              key={`${edge.source}\n${edge.target}`}
              className={dim ? 'graph__edge graph__edge--dim' : 'graph__edge'}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
            />
          );
        })}
        {graph.nodes.map((node) => (
          <Node
            key={node.id}
            node={node}
            at={positions.get(node.id)}
            radius={nodeRadius(neighbours.get(node.id)?.size ?? 0)}
            active={node.id === activePath}
            dim={lit !== null && !lit.has(node.id)}
            labelled={labelAll || lit?.has(node.id) === true || node.id === activePath}
            onHover={(on) => setHovered(on ? node.id : null)}
            onPointerDown={(event) => handlers.startDrag(event, node)}
          />
        ))}
      </g>
    </svg>
  );
}

/** Room left around the graph when it is fitted to the stage, as a share of the stage. */
const FIT_MARGIN = 0.9;
/** A few notes are fitted a little larger than life, not blown up to fill the stage. */
const FIT_MAX_ZOOM = 1.6;

/** The pan and zoom that show every note, centred, never blown up past FIT_MAX_ZOOM. */
function fitView(
  positions: ReadonlyMap<string, Point>,
  size: { width: number; height: number },
): View {
  if (positions.size === 0) return { x: 0, y: 0, k: 1 };
  const xs = [...positions.values()].map((point) => point.x);
  const ys = [...positions.values()].map((point) => point.y);
  const [left, right, top, bottom] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  // A label hangs under each dot, so the box is padded for it.
  const width = right - left + 80;
  const height = bottom - top + 80;
  const k = Math.max(
    MIN_ZOOM,
    Math.min(FIT_MAX_ZOOM, (FIT_MARGIN * size.width) / width, (FIT_MARGIN * size.height) / height),
  );
  return { x: (-(left + right) / 2) * k, y: (-(top + bottom) / 2) * k, k };
}

/** The surface's size in pixels, so the origin sits in its middle. */
function useSize(target: { current: Element | null }) {
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const element = target.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);
  return size;
}

type Gesture =
  | { readonly kind: 'pan'; readonly from: Point; readonly view: View }
  | { readonly kind: 'drag'; readonly node: GraphNode; readonly from: Point; moved: boolean };

/** Panning the ground, dragging a note, and telling a click on a note from a drag. */
function useGestures({
  view,
  setView,
  toGraph,
  drag,
  onOpenNote,
}: {
  view: View;
  setView: (view: View) => void;
  toGraph: (event: { clientX: number; clientY: number }) => Point;
  drag: (id: string, to: Point | null) => void;
  onOpenNote: (path: string) => void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const capture = (event: PointerEvent<Element>) => {
    // jsdom and some pointer types cannot capture; the gesture still works while over the surface.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  return {
    startPan: (event: PointerEvent<SVGSVGElement>) => {
      if (gesture.current !== null) return;
      capture(event);
      gesture.current = { kind: 'pan', from: { x: event.clientX, y: event.clientY }, view };
    },
    startDrag: (event: PointerEvent<SVGGElement>, node: GraphNode) => {
      event.stopPropagation();
      capture(event);
      // Hold the fitted view still: refitting while a note is dragged would move the ground under it.
      setView(view);
      gesture.current = {
        kind: 'drag',
        node,
        from: { x: event.clientX, y: event.clientY },
        moved: false,
      };
    },
    move: (event: PointerEvent<SVGSVGElement>) => {
      const now = gesture.current;
      if (now === null) return;
      const dx = event.clientX - now.from.x;
      const dy = event.clientY - now.from.y;
      if (now.kind === 'pan') {
        setView({ ...now.view, x: now.view.x + dx, y: now.view.y + dy });
      } else if (now.moved || Math.hypot(dx, dy) > CLICK_SLOP) {
        now.moved = true;
        drag(now.node.id, toGraph(event));
      }
    },
    end: (event: PointerEvent<SVGSVGElement>) => {
      const now = gesture.current;
      gesture.current = null;
      if (now?.kind !== 'drag') return;
      if (now.moved) drag(now.node.id, null);
      // A ghost is a link target with no note yet: there is nothing to open.
      else if (event.type === 'pointerup' && now.node.kind === 'note') onOpenNote(now.node.id);
    },
  };
}

function Node({
  node,
  at,
  radius,
  active,
  dim,
  labelled,
  onHover,
  onPointerDown,
}: {
  node: GraphNode;
  at: Point | undefined;
  radius: number;
  active: boolean;
  dim: boolean;
  labelled: boolean;
  onHover: (on: boolean) => void;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
}) {
  if (at === undefined) return null;
  const className = [
    'graph__node',
    node.kind === 'ghost' ? 'graph__node--ghost' : '',
    active ? 'graph__node--active' : '',
    dim ? 'graph__node--dim' : '',
  ]
    .filter((name) => name !== '')
    .join(' ');
  return (
    <g
      className={className}
      data-node={node.id}
      transform={`translate(${at.x} ${at.y})`}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onPointerDown={onPointerDown}
    >
      <circle className="graph__dot" r={radius} />
      <title>{node.kind === 'ghost' ? `${node.title} (no note yet)` : node.title}</title>
      {labelled && (
        <text className="graph__label" y={radius + 13}>
          {node.title}
        </text>
      )}
    </g>
  );
}
