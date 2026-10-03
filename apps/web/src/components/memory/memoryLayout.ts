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
