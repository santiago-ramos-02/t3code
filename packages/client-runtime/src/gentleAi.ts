import {
  CustomModelSetting,
  GENTLE_AI_CLAUDE_SLOTS,
  PI_GENTLE_ORCHESTRATOR,
  type PiGentleRouting,
  type ProviderInstanceConfig,
  type GentleAiClaudeProfile,
  type GentleAiApiStatus,
  type GentleAiJobMethod,
  type GentleAiModelAgent,
  type GentleAiModels,
  type GentleAiOddFeatures,
  type GentleAiReviewMode,
  type GentleAiReviewStore,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

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

/**
 * Continues a feature in a new thread: ODD resumes from its document, referenced as a file the
 * way the composer's @ picker does, so it shows as a file chip. The trailing space ends the chip.
 */
export function gentleOddContinuePrompt(
  feature: Pick<GentleAiOddFeatures["features"][number], "path">,
) {
  return `Implement ${serializeComposerFileLink(feature.path)} `;
}

/** A thread's text an agent's work leaves behind: messages and what its activities report. */
export interface GentleOddThreadTrail {
  readonly messages: ReadonlyArray<{ readonly text: string }>;
  readonly activities: ReadonlyArray<{ readonly payload: unknown }>;
}

/**
 * The feature documents a thread works on: named in a message (such as "Implement" from the
 * menu) or touched by its tools. Paths arrive with either slash and, inside activity payloads,
 * JSON-escaped.
 */
export function gentleOddThreadFeaturePaths(
  thread: GentleOddThreadTrail,
  paths: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (paths.length === 0) return new Set();
  const texts = [
    ...thread.messages.map((message) => message.text),
    ...thread.activities.map((activity) => JSON.stringify(activity.payload) ?? ""),
  ];
  return new Set(
    paths.filter((path) => {
      const spellings = [path, path.replaceAll("/", "\\"), path.replaceAll("/", "\\\\")];
      return texts.some((text) => spellings.some((spelling) => text.includes(spelling)));
    }),
  );
}

/**
 * The feature documents worth continuing, for a menu: unfinished ones, those this thread works
 * on first. A finished document has nothing left to continue.
 */
export function gentleOddMenuFeatures<
  F extends Pick<GentleAiOddFeatures["features"][number], "path" | "tasksDone" | "tasksTotal">,
>(features: ReadonlyArray<F>, inThread: ReadonlySet<string>) {
  const open = features
    .filter((feature) => feature.tasksTotal === 0 || feature.tasksDone < feature.tasksTotal)
    .map((feature) => ({ feature, inThread: inThread.has(feature.path) }));
  return [...open.filter((entry) => entry.inThread), ...open.filter((entry) => !entry.inThread)];
}

/** Where a feature stands, short enough for a menu row: its task progress. */
export function gentleOddFeatureSummary(
  feature: Pick<GentleAiOddFeatures["features"][number], "tasksDone" | "tasksTotal">,
): string {
  if (feature.tasksTotal === 0) return "No tasks";
  return feature.tasksDone === feature.tasksTotal
    ? "Done"
    : `${feature.tasksDone}/${feature.tasksTotal} tasks`;
}

/**
 * One line on what a Claude Code profile runs: each set slot's model, then how many phases it
 * pins, if any.
 */
export function gentleAiClaudeProfileSummary(
  profile: Pick<GentleAiClaudeProfile, "slots" | "phases">,
): string {
  const slots = GENTLE_AI_CLAUDE_SLOTS.flatMap((slot) => {
    const value = profile.slots[slot];
    if (value === undefined) return [];
    const name = (value.label ?? value.model).replace(/^Claude /, "");
    // "Opus 5.5" already says it runs in the opus slot; a slot running another model says which.
    return [name.toLowerCase().includes(slot) ? name : `${slot} ${name}`];
  });
  const pinned = Object.keys(profile.phases ?? {}).length;
  const parts = [
    ...slots,
    ...(pinned === 0 ? [] : [`${pinned} phase${pinned === 1 ? "" : "s"} fixed`]),
  ];
  return parts.length === 0 ? "Claude Code's own models" : parts.join(" · ");
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

/**
 * What a gentle-pi profile runs, in a line: the orchestrator's model and effort, then the other
 * models its roles use, most used first. `nameOf` names a model by the ID the profile stores.
 */
export function gentlePiProfileSummary(
  routing: PiGentleRouting,
  nameOf: (model: string) => string | undefined,
): string {
  const short = (model: string) =>
    (nameOf(model) ?? model.slice(model.lastIndexOf("/") + 1))
      .replace(/^Claude /, "")
      .replace(/ 1M$/, "");
  const lead = routing[PI_GENTLE_ORCHESTRATOR];
  const leadName = lead?.model === undefined ? "Pi's default" : short(lead.model);
  const uses = new Map<string, number>();
  for (const [role, entry] of Object.entries(routing)) {
    if (role === PI_GENTLE_ORCHESTRATOR || entry.model === undefined) continue;
    const name = short(entry.model);
    if (name !== leadName) uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  const others = [...uses].sort((left, right) => right[1] - left[1]).map(([name]) => name);
  return [lead?.thinking ? `${leadName} ${lead.thinking}` : leadName, ...others].join(" · ");
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

/**
 * One line on a project's review history: what clearing it would remove, reviews still open,
 * and what the last clear removed when that is known.
 */
export function gentleAiReviewHistoryLabel(
  counts: ReturnType<typeof gentleAiReviewStoreSummary>,
  lastRemovedFiles: number | null = null,
): string {
  const count = (value: number, one: string, many: string) =>
    `${value} ${value === 1 ? one : many}`;
  return [
    counts.removable === 0 && counts.inFlight === 0
      ? "Nothing to clear"
      : `${count(counts.removable, "entry", "entries")} (${formatGentleAiBytes(counts.removableBytes)})`,
    counts.inFlight > 0 ? `${count(counts.inFlight, "review", "reviews")} in progress` : null,
    lastRemovedFiles === null
      ? null
      : `Last clear removed ${count(lastRemovedFiles, "file", "files")}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
