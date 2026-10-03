import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";

export const MEMORY_NODE_RADIUS = 4;

export type MemoryLayout = ReturnType<typeof layoutMemoryGraph>;
// Enough for the layout to settle; it runs once per change, never as an animation.
const TICKS = 240;

interface LayoutNode extends SimulationNodeDatum {
  readonly id: string;
}

interface LayoutLink {
  readonly source: string;
  readonly target: string;
  readonly strength: number;
}

/**
 * Where each memory sits on the brain map. Relations pull harder than session threads, so related
 * memories end up side by side and each session forms its own cluster. d3-force starts from a
 * fixed spiral, so the same graph always lands in the same place.
 */
export function layoutMemoryGraph(graph: {
  readonly nodes: ReadonlyArray<{ readonly id: string }>;
  readonly edges: ReadonlyArray<{ readonly source: string; readonly target: string }>;
  readonly threads: ReadonlyArray<{ readonly source: string; readonly target: string }>;
}) {
  const nodes: Array<LayoutNode> = graph.nodes.map((node) => ({ id: node.id }));
  const links: Array<LayoutLink> = [
    ...graph.edges.map((edge) => ({ source: edge.source, target: edge.target, strength: 0.7 })),
    ...graph.threads.map((thread) => ({ ...thread, strength: 0.25 })),
  ];
  forceSimulation(nodes)
    .force(
      "link",
      forceLink<LayoutNode, LayoutLink>(links)
        .id((node) => node.id)
        .distance(16)
        .strength((link) => link.strength),
    )
    .force("charge", forceManyBody().strength(-12).distanceMax(160))
    .force("x", forceX().strength(0.05))
    .force("y", forceY().strength(0.05))
    .force("collide", forceCollide(MEMORY_NODE_RADIUS + 2))
    .stop()
    .tick(TICKS);

  const positions = new Map(nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
  const xs = nodes.map((node) => node.x ?? 0);
  const ys = nodes.map((node) => node.y ?? 0);
  const pad = MEMORY_NODE_RADIUS * 4;
  const minX = Math.min(0, ...xs) - pad;
  const minY = Math.min(0, ...ys) - pad;
  return {
    positions,
    viewBox: {
      x: minX,
      y: minY,
      width: Math.max(0, ...xs) + pad - minX,
      height: Math.max(0, ...ys) + pad - minY,
    },
  };
}

// Past this the map reads as streaks rather than clusters.
const MAX_STRETCH = 3;

/**
 * Spreads a layout to the plot's width-to-height ratio, so a round cluster fills a wide plot
 * instead of sitting in its middle. Only the spacing changes; dots stay round.
 */
export function fitLayoutToAspect(layout: MemoryLayout, aspect: number): MemoryLayout {
  const { viewBox } = layout;
  if (!(aspect > 0) || viewBox.width === 0 || viewBox.height === 0) return layout;
  const current = viewBox.width / viewBox.height;
  const stretchX = current < aspect ? Math.min(aspect / current, MAX_STRETCH) : 1;
  const stretchY = current > aspect ? Math.min(current / aspect, MAX_STRETCH) : 1;
  if (stretchX === 1 && stretchY === 1) return layout;
  const centerX = viewBox.x + viewBox.width / 2;
  const centerY = viewBox.y + viewBox.height / 2;
  const positions = new Map(
    Array.from(layout.positions, ([id, { x, y }]) => [
      id,
      { x: centerX + (x - centerX) * stretchX, y: centerY + (y - centerY) * stretchY },
    ]),
  );
  const width = viewBox.width * stretchX;
  const height = viewBox.height * stretchY;
  return {
    positions,
    viewBox: { x: centerX - width / 2, y: centerY - height / 2, width, height },
  };
}
