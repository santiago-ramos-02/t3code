import { describe, expect, it } from "vite-plus/test";

import { layoutMemoryGraph } from "./memoryLayout";

const node = (id: string) => ({ id });

describe("layoutMemoryGraph", () => {
  const graph = {
    nodes: ["a", "b", "c", "d", "e", "f"].map(node),
    edges: [{ source: "a", target: "b" }],
    threads: [
      { source: "c", target: "d" },
      { source: "d", target: "e" },
    ],
  };

  it("places every memory the same way each time", () => {
    const first = layoutMemoryGraph(graph);
    const second = layoutMemoryGraph(graph);
    expect([...first.positions.values()].every((p) => Number.isFinite(p.x + p.y))).toBe(true);
    expect([...second.positions]).toEqual([...first.positions]);
  });

  it("frames every memory inside the view box", () => {
    const { positions, viewBox } = layoutMemoryGraph(graph);
    for (const { x, y } of positions.values()) {
      expect(x).toBeGreaterThan(viewBox.x);
      expect(y).toBeGreaterThan(viewBox.y);
      expect(x).toBeLessThan(viewBox.x + viewBox.width);
      expect(y).toBeLessThan(viewBox.y + viewBox.height);
    }
  });

  it("puts related memories closer than unrelated ones", () => {
    const { positions } = layoutMemoryGraph(graph);
    const distance = (from: string, to: string) => {
      const a = positions.get(from);
      const b = positions.get(to);
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Number.NaN;
    };
    expect(distance("a", "b")).toBeLessThan(distance("a", "f"));
  });
});
