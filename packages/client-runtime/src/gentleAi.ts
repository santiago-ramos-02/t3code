import {
  CustomModelSetting,
  GENTLE_AI_CLAUDE_SLOTS,
  type ProviderInstanceConfig,
  type GentleAiClaudeProfile,
  type GentleAiApiStatus,
  type GentleAiJobMethod,
  type GentleAiModelAgent,
  type GentleAiModels,
  type GentleAiOddFeatures,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
  "plugins.install": "Installing plugins",
  "plugins.uninstall": "Removing plugin",
  "tools.install": "Installing community tools",
  "builder.generate": "Generating agent",
  "builder.install": "Installing agent",
  "review.set": "Changing the review setting",
  "reviewStore.reset": "Clearing review history",
  "uninstall.run": "Removing Gentle AI",
  "claude.profiles.save": "Saving the Claude Code profile",
  "claude.profiles.delete": "Deleting the Claude Code profile",
  "claude.profiles.apply": "Switching the Claude Code profile",
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

/**
 * Starts a spec thread: ODD writes the feature document only, from the description the user
 * adds after it, and asks about product decisions. Naming the feature document matters: a plain
 * "write the spec" produces a free-form document instead.
 */
export const GENTLE_ODD_NEW_SPEC_PROMPT =
  "Create the ODD feature document for the feature below. Only the feature document; don't change any code. Ask me about any product decision you need. The feature: ";

/** Continues a feature in a new thread: ODD resumes from its document. */
export function gentleOddContinuePrompt(
  feature: Pick<GentleAiOddFeatures["features"][number], "path">,
) {
  return `Implement ${feature.path}.`;
}

/** One line on where a feature stands: its task progress and next step. */
export function gentleOddFeatureSummary(
  feature: Pick<GentleAiOddFeatures["features"][number], "tasksDone" | "tasksTotal" | "nextStep">,
): string {
  const tasks =
    feature.tasksTotal === 0
      ? "No tasks yet"
      : feature.tasksDone === feature.tasksTotal
        ? `All ${feature.tasksTotal} tasks done`
        : `${feature.tasksDone} of ${feature.tasksTotal} tasks done`;
  return feature.nextStep ? `${tasks} · Next: ${feature.nextStep}` : tasks;
}

/**
 * One line on what a Claude Code profile does: what each slot runs, then whether the
 * orchestrator picks the phases' models or the profile pins them.
 */
export function gentleAiClaudeProfileSummary(
  profile: Pick<GentleAiClaudeProfile, "slots" | "phases">,
): string {
  const slots = GENTLE_AI_CLAUDE_SLOTS.flatMap((slot) => {
    const value = profile.slots[slot];
    return value === undefined ? [] : [`${slot} → ${value.label ?? value.model}`];
  });
  const pinned = Object.keys(profile.phases ?? {}).length;
  const phases =
    pinned === 0
      ? "Claude picks models per task"
      : `${pinned} phase${pinned === 1 ? "" : "s"} pinned`;
  return [...slots, phases].join(" · ");
}

/** Why a Claude Code profile has no effect yet: no Claude Code provider goes through a proxy. */
export const GENTLE_AI_CLAUDE_PROFILE_NEEDS_PROXY =
  "Profiles apply to Claude Code providers that go through a proxy. Turn on Use in T3 Code in Settings > CLIProxyAPI.";

/**
 * Whether a provider is Claude Code talking to a gateway such as CLIProxyAPI. Claude Code
 * profiles apply only to these, so Claude Code reaching Anthropic directly keeps its own models.
 */
export function isProxiedClaudeInstance(instance: ProviderInstanceConfig): boolean {
  return (
    instance.driver === "claudeAgent" &&
    instance.enabled !== false &&
    (instance.environment ?? []).some(
      (variable) =>
        variable.name === "ANTHROPIC_BASE_URL" &&
        (variable.value.trim() !== "" || variable.valueRedacted === true),
    )
  );
}

const decodeCustomModels = Schema.decodeUnknownOption(
  Schema.Struct({ customModels: Schema.Array(CustomModelSetting) }),
);

/** The models a Claude Code profile slot can run: what every proxied Claude Code serves. */
export function claudeProfileSlotModels(
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  const models = new Map<string, string>();
  for (const instance of Object.values(instances)) {
    if (!isProxiedClaudeInstance(instance)) continue;
    const config = Option.getOrUndefined(decodeCustomModels(instance.config));
    for (const model of config?.customModels ?? []) {
      const [id, label] =
        typeof model === "string" ? [model, model] : [model.slug, model.name ?? model.slug];
      if (!models.has(id)) models.set(id, label);
    }
  }
  return [...models].map(([id, label]) => ({ id, label }));
}
