import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { MemoryFacts, memoryTimeLabel } from "./memoryParts";
import {
  fitLayoutToAspect,
  layoutMemoryGraph,
  MEMORY_NODE_RADIUS,
  type MemoryLayout,
} from "./memoryLayout";
import {
  MEMORY_GROUP_LABELS,
  type MemoryGraph,
  type MemoryGraphNode,
  type MemoryGroup,
} from "./memoryModel";

// Validated with the dataviz palette checks (all pairs, light and dark): only three hues are
// safe when any memory can sit next to any other, so everything else is gray.
const GROUP_COLOR: Record<MemoryGroup, string> = {
  decisions: "var(--memory-decisions)",
  findings: "var(--memory-findings)",
  sessions: "var(--memory-sessions)",
  other: "var(--memory-other)",
};
const PALETTE_CLASS =
  "[--memory-decisions:#2a78d6] [--memory-findings:#eb6834] [--memory-sessions:#1baf7a] [--memory-other:#8b8f97] dark:[--memory-decisions:#3987e5] dark:[--memory-findings:#d95926] dark:[--memory-sessions:#199e70] dark:[--memory-other:#80848c]";
const GROUP_ORDER: ReadonlyArray<MemoryGroup> = ["decisions", "findings", "sessions", "other"];

let lastLayout: { readonly key: string; readonly layout: MemoryLayout } | null = null;

/** The layout for a graph's shape, kept while the shape stays the same. */
function layoutForShape(key: string, graph: MemoryGraph) {
  if (lastLayout?.key !== key) lastLayout = { key, layout: layoutMemoryGraph(graph) };
  return lastLayout.layout;
}

/**
 * Every memory as a dot, colored by kind. Lines are relations Engram or a person recorded; faint
 * lines thread each session's memories in order. Clicking a dot opens it.
 */
export function MemoryBrainMap(props: {
  readonly graph: MemoryGraph;
  // The memory open in the detail panel, kept marked while it is read.
  readonly selectedMemoryId: number | null;
  readonly onOpenMemory: (id: number) => void;
}) {
  const { graph } = props;
  const [view, setView] = useState<"map" | "list">("map");
  // The layout depends only on which memories and links there are, so a refresh that changes
  // nothing keeps every dot where it was.
  const shapeKey = useMemo(
    () =>
      [
        graph.nodes.map((node) => node.id).join(","),
        graph.edges.map((edge) => edge.id).join(","),
        graph.threads.length,
      ].join("|"),
    [graph],
  );
  const layout = useMemo(() => layoutForShape(shapeKey, graph), [shapeKey, graph]);
  const groups = useMemo(() => {
    const counts = new Map<MemoryGroup, number>();
    for (const node of graph.nodes) counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    return GROUP_ORDER.filter((group) => (counts.get(group) ?? 0) > 0).map((group) => ({
      group,
      count: counts.get(group) ?? 0,
    }));
  }, [graph.nodes]);
  const flagged = graph.nodes.some((node) => node.conflicted);
  const faded = graph.nodes.some((node) => node.superseded);

  return (
    <section className={`flex min-w-0 flex-col gap-3 ${PALETTE_CLASS}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-sm font-medium">Brain map</h2>
        <ToggleGroup
          aria-label="Brain map view"
          variant="segmented"
          value={[view]}
          onValueChange={(next) => {
            if (next[0] === "map" || next[0] === "list") setView(next[0]);
          }}
        >
          <Toggle value="map">Map</Toggle>
          <Toggle value="list">List</Toggle>
        </ToggleGroup>
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {groups.map(({ group, count }) => (
          <li key={group} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: GROUP_COLOR[group] }}
            />
            {MEMORY_GROUP_LABELS[group]} <span className="tabular-nums">{count}</span>
          </li>
        ))}
        {flagged ? (
          <li className="flex items-center gap-1.5">
            <TriangleAlertIcon aria-hidden className="size-3 text-warning" />
            Contradicts another, or needs your call
          </li>
        ) : null}
        {faded ? <li>Faded: replaced by a newer memory</li> : null}
      </ul>
      {view === "map" ? (
        <MemoryMapPlot
          graph={graph}
          layout={layout}
          selectedMemoryId={props.selectedMemoryId}
          onOpenMemory={props.onOpenMemory}
        />
      ) : (
        <MemoryMapList graph={graph} onOpenMemory={props.onOpenMemory} />
      )}
      {graph.hidden > 0 ? (
        <p className="text-xs text-muted-foreground">
          Showing the newest {graph.nodes.length.toLocaleString()}; pick a project to see the
          others.
        </p>
      ) : null}
    </section>
  );
}

function MemoryMapPlot(props: {
  readonly graph: MemoryGraph;
  readonly layout: MemoryLayout;
  readonly selectedMemoryId: number | null;
  readonly onOpenMemory: (id: number) => void;
}) {
  const { graph } = props;
  const selectedId =
    graph.nodes.find((node) => node.observation.id === props.selectedMemoryId)?.id ?? null;
  const plotRef = useRef<HTMLDivElement | null>(null);
  // The plot's width over its height, so the layout can spread to fill it.
  const [aspect, setAspect] = useState(0);
  useEffect(() => {
    const plot = plotRef.current;
    if (plot === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box && box.height > 0) setAspect(Math.round((box.width / box.height) * 20) / 20);
    });
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => fitLayoutToAspect(props.layout, aspect), [props.layout, aspect]);
  const [hover, setHover] = useState<{
    readonly node: MemoryGraphNode;
    readonly left: number;
    readonly top: number;
    readonly right: boolean;
    readonly bottom: boolean;
  } | null>(null);
  const { x, y, width, height } = layout.viewBox;
  const hoveredId = hover?.node.id ?? null;
  // Hovering looks around; with nothing hovered, the open memory keeps its neighbors lit.
  const focusId = hoveredId ?? selectedId;
  const connected = useMemo(() => {
    if (focusId === null) return null;
    const ids = new Set([focusId]);
    for (const edge of graph.edges) {
      if (edge.source === focusId) ids.add(edge.target);
      if (edge.target === focusId) ids.add(edge.source);
    }
    return ids;
  }, [graph.edges, focusId]);

  const showTooltip = (node: MemoryGraphNode, target: Element) => {
    const plot = plotRef.current;
    if (plot === null) return;
    const bounds = plot.getBoundingClientRect();
    const dot = target.getBoundingClientRect();
    const left = dot.left + dot.width / 2 - bounds.left;
    const top = dot.top + dot.height / 2 - bounds.top;
    setHover({
      node,
      left,
      top,
      right: left > bounds.width / 2,
      bottom: top > bounds.height / 2,
    });
  };

  return (
    <div
      ref={plotRef}
      className="relative h-[26rem] w-full overflow-hidden rounded-lg border bg-card max-sm:h-80"
      onPointerLeave={() => setHover(null)}
    >
      <svg
        className="h-full w-full"
        viewBox={`${x} ${y} ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${graph.nodes.length} memories and ${graph.edges.length} relations`}
      >
        <g className="text-border">
          {graph.threads.map((thread) => {
            const from = layout.positions.get(thread.source);
            const to = layout.positions.get(thread.target);
            if (!from || !to) return null;
            return (
              <line
                key={`${thread.source}>${thread.target}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="currentColor"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>
        {graph.edges.map((edge) => {
          const from = layout.positions.get(edge.source);
          const to = layout.positions.get(edge.target);
          if (!from || !to) return null;
          const warning = edge.pending || edge.kind === "conflicts_with";
          const dim =
            connected !== null && !(connected.has(edge.source) && connected.has(edge.target));
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="currentColor"
              strokeWidth={warning ? 1.5 : 1}
              strokeDasharray={edge.pending ? "3 2" : undefined}
              strokeOpacity={dim ? 0.15 : 0.7}
              className={warning ? "text-warning" : "text-muted-foreground"}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {graph.nodes.map((node) => {
          const position = layout.positions.get(node.id);
          if (!position) return null;
          const dim = connected !== null && !connected.has(node.id);
          return (
            <g
              key={node.id}
              transform={`translate(${position.x} ${position.y})`}
              className="cursor-pointer"
              opacity={dim ? 0.25 : node.superseded ? 0.35 : 1}
              onPointerEnter={(event) => showTooltip(node, event.currentTarget)}
              onClick={() => props.onOpenMemory(node.observation.id)}
            >
              {/* A target bigger than the dot, so small dots are easy to hit. */}
              <circle r={MEMORY_NODE_RADIUS * 2} fill="transparent" />
              {node.conflicted ? (
                <circle
                  r={MEMORY_NODE_RADIUS + 2.5}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  className="text-warning"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {selectedId === node.id ? (
                <circle
                  r={MEMORY_NODE_RADIUS + 4}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  className="text-foreground"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <circle
                r={
                  hoveredId === node.id || selectedId === node.id
                    ? MEMORY_NODE_RADIUS + 1
                    : MEMORY_NODE_RADIUS
                }
                fill={GROUP_COLOR[node.group]}
                stroke="var(--color-card)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>
      {hover ? (
        <div
          className="surface-glass pointer-events-none absolute z-10 w-max max-w-72 rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
          // Opens away from the nearest edges, so it never leaves the plot.
          style={{
            left: hover.left,
            top: hover.top,
            transform: `translate(${hover.right ? "calc(-100% - 10px)" : "10px"}, ${hover.bottom ? "calc(-100% - 10px)" : "10px"})`,
          }}
        >
          <div className="font-medium text-foreground">{hover.node.observation.title}</div>
          <MemoryFacts observation={hover.node.observation} className="mt-1" />
          {hover.node.conflicted ? (
            <div className="mt-1 flex items-center gap-1 text-warning-foreground">
              <TriangleAlertIcon aria-hidden className="size-3" />
              Contradicts another, or needs your call
            </div>
          ) : null}
          {hover.node.superseded ? (
            <div className="mt-1 text-muted-foreground">Replaced by a newer memory</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The same memories as a table, for reading without color or a pointer. */
function MemoryMapList(props: {
  readonly graph: MemoryGraph;
  readonly onOpenMemory: (id: number) => void;
}) {
  return (
    <div className="max-h-[26rem] overflow-y-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
          <tr className="border-b text-start">
            <th className="px-3 py-2 text-start font-medium">Memory</th>
            <th className="px-3 py-2 text-start font-medium max-sm:hidden">Kind</th>
            <th className="px-3 py-2 text-start font-medium max-md:hidden">Project</th>
            <th className="px-3 py-2 text-end font-medium">Saved</th>
          </tr>
        </thead>
        <tbody>
          {props.graph.nodes.map((node) => (
            <tr key={node.id} className="border-b last:border-b-0">
              <td className="px-3 py-1.5">
                <button
                  type="button"
                  className="flex cursor-pointer items-center gap-1.5 text-start underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => props.onOpenMemory(node.observation.id)}
                >
                  {node.conflicted ? (
                    <TriangleAlertIcon
                      aria-label="Contradicts another, or needs your call"
                      className="size-3 shrink-0 text-warning"
                    />
                  ) : null}
                  <span className={node.superseded ? "text-muted-foreground line-through" : ""}>
                    {node.observation.title}
                  </span>
                </button>
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground max-sm:hidden">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: GROUP_COLOR[node.group] }}
                  />
                  {node.observation.type.replaceAll("_", " ")}
                </span>
              </td>
              <td className="px-3 py-1.5 text-muted-foreground max-md:hidden">
                {node.observation.project ?? ""}
              </td>
              <td className="px-3 py-1.5 text-end whitespace-nowrap text-muted-foreground tabular-nums">
                {memoryTimeLabel(node.observation.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
