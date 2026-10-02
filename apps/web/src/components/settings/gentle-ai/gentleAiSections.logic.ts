import type {
  GentleAiApiStatus,
  GentleAiReviewMode,
  GentleAiReviewStore,
  GentleAiTools,
  GentleAiUninstallMode,
  GentleAiUninstallParams,
} from "@t3tools/contracts";

interface GentleAiScopeMember {
  readonly environmentId: string;
  readonly workspaceRoot: string;
}

/** The parts of a resolved settings scope that name a project. */
type GentleAiScope =
  | {
      readonly kind: "project";
      readonly group: { readonly displayName: string };
      readonly members: ReadonlyArray<GentleAiScopeMember>;
    }
  | {
      readonly kind: "checkout";
      readonly group: { readonly displayName: string };
      readonly checkout: GentleAiScopeMember;
    }
  | { readonly kind: "all" | "environment" | "unavailable" };

/**
 * The project Gentle AI's project settings apply to: the one chosen at the top of Settings, as
 * its folder on the environment the page manages. Gentle AI keeps them per folder (checkout).
 */
export function gentleAiScopeProject(
  scope: GentleAiScope,
  environmentId: string,
): { readonly title: string; readonly cwd: string } | null {
  const member =
    scope.kind === "checkout"
      ? scope.checkout
      : scope.kind === "project"
        ? scope.members.find((candidate) => candidate.environmentId === environmentId)
        : undefined;
  if (member === undefined || (scope.kind !== "project" && scope.kind !== "checkout")) return null;
  return { title: scope.group.displayName, cwd: member.workspaceRoot };
}

/**
 * Review for one project: it follows the switch for every project unless the project turned it
 * off here. gentle-ai only keeps an "off" per project, so it cannot be on here while off for
 * every project.
 */
export function gentleAiProjectReview(mode: GentleAiReviewMode) {
  return {
    checked: mode.status.effective === "on",
    overridden: mode.status.clone_local === "off",
    canTurnOn: mode.status.global !== "off",
  };
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
 * agents or components. Full modes cover everything, so they send no lists. A project only
 * adds project cleanup.
 */
export function gentleAiUninstallPlanParams(
  draft: GentleAiUninstallDraft,
  cwd: string | null,
): GentleAiUninstallParams | null {
  const project = cwd === null ? {} : { cwd };
  if (draft.mode !== "partial") return { mode: draft.mode, ...project };
  if (draft.agents.length === 0 || draft.components.length === 0) return null;
  return { mode: draft.mode, agents: draft.agents, components: draft.components, ...project };
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
