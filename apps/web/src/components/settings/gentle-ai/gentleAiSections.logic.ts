import type {
  GentleAiApiStatus,
  GentleAiReviewMode,
  GentleAiReviewStore,
  GentleAiTools,
  GentleAiUninstallMode,
  GentleAiUninstallParams,
} from "@t3tools/contracts";

/** The project a cwd-scoped Gentle AI action applies to: the user's choice while it exists, else the first. */
export function gentleAiProjectCwd(
  projects: ReadonlyArray<{ readonly cwd: string }>,
  choice: string | null,
): string | null {
  if (choice !== null && projects.some((project) => project.cwd === choice)) return choice;
  return projects[0]?.cwd ?? null;
}

/** Agent and component names by id, for showing what gentle-ai reports by id. */
export function gentleAiNames(status: GentleAiApiStatus): ReadonlyMap<string, string> {
  return new Map([
    ...status.agents.map((agent) => [agent.id, agent.name] as const),
    ...status.components.map((component) => [component.id, component.name] as const),
  ]);
}

// ---- Community tools -------------------------------------------------------------------------

/** One line of a community tool's state: CLI presence, then which detected agents it is wired into. */
export function gentleAiToolSummary(
  tool: GentleAiTools["tools"][number],
  names: ReadonlyMap<string, string>,
): string {
  const name = (id: string) => names.get(id) ?? id;
  const detected = tool.agents.filter((agent) => agent.detected);
  const configured = detected.filter((agent) => agent.configured).map((agent) => name(agent.agent));
  const missing = detected.filter((agent) => !agent.configured).map((agent) => name(agent.agent));
  return [
    tool.cliAvailable ? "CLI installed" : "CLI not installed",
    configured.length > 0 ? `Configured for ${configured.join(", ")}` : null,
    missing.length > 0 ? `Not configured for ${missing.join(", ")}` : null,
    detected.length === 0 ? "No supported agent detected" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Whether installing would change nothing the tool reports: CLI present and every detected agent wired. */
export function gentleAiToolInstalled(tool: GentleAiTools["tools"][number]): boolean {
  return tool.cliAvailable && tool.agents.every((agent) => !agent.detected || agent.configured);
}

// ---- Review ----------------------------------------------------------------------------------

/** RDD is on unless the global switch was turned off; "" means it was never chosen. */
export function gentleAiReviewGlobalEnabled(mode: GentleAiReviewMode): boolean {
  return mode.status.global !== "off";
}

/** Whether this clone has its own off override, which wins over the global switch. */
export function gentleAiReviewCloneDisabled(mode: GentleAiReviewMode): boolean {
  return mode.status.clone_local === "off";
}

/** What a reset would remove now, and how many open reviews would block it. */
export function gentleAiReviewStoreSummary(store: GentleAiReviewStore) {
  const removable = store.report.removable.filter((entry) => entry.present);
  return {
    removable: removable.length,
    removableBytes: removable.reduce((total, entry) => total + entry.bytes, 0),
    inFlight: store.report.in_flight.length,
  };
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatGentleAiBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

// ---- Uninstall -------------------------------------------------------------------------------

export const GENTLE_AI_UNINSTALL_MODES = [
  {
    mode: "partial",
    label: "Partial",
    description: "Remove chosen components from chosen agents.",
  },
  {
    mode: "full",
    label: "Full",
    description: "Remove everything Gentle AI configured, from every agent.",
  },
  {
    mode: "full-remove",
    label: "Full and remove gentle-ai",
    description:
      "Remove everything, then delete the gentle-ai binary. Setting up again needs a reinstall.",
  },
  {
    mode: "clean-install",
    label: "Clean reinstall",
    description: "Remove everything, then set it up again from your current choices.",
  },
] as const satisfies ReadonlyArray<{
  readonly mode: GentleAiUninstallMode;
  readonly label: string;
  readonly description: string;
}>;

export interface GentleAiUninstallDraft {
  readonly mode: GentleAiUninstallMode;
  readonly agents: ReadonlyArray<string>;
  readonly components: ReadonlyArray<string>;
}

/**
 * What to ask gentle-ai to plan for a draft, or null while a partial uninstall is missing its
 * agents or components. Full modes cover everything, so they send no lists.
 */
export function gentleAiUninstallPlanParams(
  draft: GentleAiUninstallDraft,
  cwd: string,
): GentleAiUninstallParams | null {
  if (draft.mode !== "partial") return { mode: draft.mode, cwd };
  if (draft.agents.length === 0 || draft.components.length === 0) return null;
  return { mode: draft.mode, agents: draft.agents, components: draft.components, cwd };
}

/** The run request: the planned request plus the choices the plan offered. */
export function gentleAiUninstallRunParams(
  planned: GentleAiUninstallParams,
  choices: {
    readonly engramScope: "global" | "project" | null;
  },
): GentleAiUninstallParams {
  return {
    ...planned,
    ...(choices.engramScope === null ? {} : { engramScope: choices.engramScope }),
  };
}

/** Toggles an id in a selection, keeping the source order. */
export function toggleGentleAiId(
  order: ReadonlyArray<string>,
  selected: ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> {
  const next = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
  return order.filter((entry) => next.includes(entry));
}
