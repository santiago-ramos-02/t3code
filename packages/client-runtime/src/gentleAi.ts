import type {
  GentleAiApiStatus,
  GentleAiJobMethod,
  GentleAiModelAgent,
  GentleAiModels,
} from "@t3tools/contracts";

/** What each Gentle AI job is called while it runs and after, on every client. */
export const GENTLE_AI_JOB_LABELS = {
  install: "Setting up Gentle AI",
  sync: "Syncing agent files",
  upgrade: "Updating",
  "models.set": "Applying models",
  "backups.restore": "Restoring backup",
  "backups.delete": "Deleting backup",
  "backups.rename": "Renaming backup",
  "backups.pin": "Updating backup",
  "plugins.install": "Installing OpenCode plugins",
  "plugins.uninstall": "Removing OpenCode plugin",
  "tools.install": "Installing community tools",
  "builder.generate": "Generating agent",
  "builder.install": "Installing agent",
  "review.set": "Changing the review setting",
  "reviewStore.reset": "Clearing review history",
  "uninstall.run": "Removing Gentle AI",
} satisfies Record<GentleAiJobMethod, string>;

export type GentleAiAgentState = "set-up" | "available" | "unsupported";

/**
 * The agents Gentle AI settings list: the ones Gentle AI set up, then the others found on the
 * environment. Agents that are neither are left out; the setup flow still offers them.
 */
export function gentleAiAgentList(status: Pick<GentleAiApiStatus, "agents">) {
  const listed = status.agents.flatMap((agent) => {
    const state: GentleAiAgentState | null = agent.installed
      ? "set-up"
      : !agent.detected
        ? null
        : agent.supported
          ? "available"
          : "unsupported";
    return state === null ? [] : [{ id: agent.id, name: agent.name, state }];
  });
  return [
    ...listed.filter((agent) => agent.state === "set-up"),
    ...listed.filter((agent) => agent.state !== "set-up"),
  ];
}

const MODEL_AGENTS = [
  "claude-code",
  "codex",
  "kiro-ide",
  "opencode",
] as const satisfies ReadonlyArray<GentleAiModelAgent>;

/** The agent ids gentle-ai configures models for, or null for the others. */
export function gentleAiModelAgent(id: string): GentleAiModelAgent | null {
  return MODEL_AGENTS.find((candidate) => candidate === id) ?? null;
}

/**
 * Whether an agent's models assign nothing, so every phase runs on gentle-ai's defaults.
 * gentle-ai reports no preset both for this and for custom choices.
 */
export function gentleAiModelsAllDefault(value: GentleAiModels): boolean {
  return Object.values(value).every(
    (entry) =>
      entry === undefined ||
      entry === false ||
      (Array.isArray(entry)
        ? entry.length === 0
        : typeof entry === "object" && Object.keys(entry).length === 0),
  );
}

/** Whether the agents' files are behind the installed gentle-ai, so a sync would update them. */
export function gentleAiSyncNeeded(status: Pick<GentleAiApiStatus, "state">): boolean {
  return status.state.syncNeeded ?? status.state.pendingSync;
}
