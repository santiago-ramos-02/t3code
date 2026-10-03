import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { MemoryPage } from "../components/memory/MemoryPage";

export interface MemorySearch {
  readonly environmentId?: EnvironmentId;
  // The memory open in the detail panel.
  readonly memory?: number;
  // A search to start with, from an agent's memory search in a thread.
  readonly q?: string;
  // Engram's project name; every project when absent.
  readonly project?: string;
}

export const Route = createFileRoute("/memory")({
  validateSearch: (raw: Record<string, unknown>): MemorySearch => {
    const memory = Number(raw.memory);
    return {
      ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
        ? { environmentId: EnvironmentId.make(raw.environmentId) }
        : {}),
      ...(Number.isInteger(memory) && memory > 0 ? { memory } : {}),
      ...(typeof raw.q === "string" && raw.q.trim() ? { q: raw.q } : {}),
      ...(typeof raw.project === "string" && raw.project.trim() ? { project: raw.project } : {}),
    };
  },
  component: MemoryPage,
});
