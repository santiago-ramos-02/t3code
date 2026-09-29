import type {
  GentleAiApiStatus,
  GentleAiInstallParams,
  GentleAiModelAgent,
  GentleAiModels,
  GentleAiPlan,
} from "@t3tools/contracts";

/** Everything the setup wizard collects before it installs. */
export interface GentleAiSetupDraft {
  readonly agents: ReadonlyArray<string>;
  readonly persona: string;
  readonly preset: string;
  // Chosen only for the custom preset; otherwise the preset decides.
  readonly components: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly rdd: boolean;
  readonly openCodePlugins: ReadonlyArray<string>;
  readonly piPlugins: ReadonlyArray<string>;
  readonly background: {
    readonly opencode: "auto" | "on" | "off";
    readonly pi: "auto" | "on" | "off";
  };
  // Per agent: a preset id, or custom models edited in the wizard.
  readonly models: Readonly<
    Partial<
      Record<GentleAiModelAgent, { readonly preset: string } | { readonly models: GentleAiModels }>
    >
  >;
}

export const CUSTOM_PRESET = "custom";

/**
 * The wizard's starting point, like the TUI's: what gentle-ai recorded choosing, else the agents
 * it detects, else nothing selected so the user picks. `addAgent` joins the agents already set up:
 * an install replaces gentle-ai's list of set-up agents, so leaving them out would drop them.
 */
export function initialSetupDraft(
  status: GentleAiApiStatus,
  addAgent?: string,
): GentleAiSetupDraft {
  const installed = status.agents.filter((agent) => agent.installed).map((agent) => agent.id);
  const detected = status.agents.filter((agent) => agent.detected).map((agent) => agent.id);
  const preset =
    status.state.preset ??
    status.presets.find((entry) => entry.id === "full-gentleman")?.id ??
    status.presets[0]?.id ??
    CUSTOM_PRESET;
  return {
    agents:
      addAgent !== undefined
        ? [...new Set([...installed, addAgent])]
        : installed.length > 0
          ? installed
          : detected,
    persona: status.state.persona ?? status.personas[0]?.id ?? "",
    preset,
    components: status.components
      .filter((component) => component.installed)
      .map((component) => component.id),
    // Like the TUI's skill picker: what is installed, else every skill.
    skills: status.skills.some((skill) => skill.installed)
      ? status.skills.filter((skill) => skill.installed).map((skill) => skill.id)
      : status.skills.map((skill) => skill.id),
    rdd: status.state.rddMode !== "off",
    openCodePlugins: [],
    piPlugins: [],
    background: {
      opencode: backgroundChoice(status.state.background.opencode),
      pi: backgroundChoice(status.state.background.pi),
    },
    models: {},
  };
}

function backgroundChoice(value: string | undefined): "auto" | "on" | "off" {
  return value === "on" || value === "off" ? value : "auto";
}

/** Components the draft installs: the preset's, or the user's own for the custom preset. */
export function draftComponents(
  status: GentleAiApiStatus,
  draft: GentleAiSetupDraft,
): ReadonlyArray<string> {
  if (draft.preset === CUSTOM_PRESET) return draft.components;
  return status.presets.find((preset) => preset.id === draft.preset)?.components ?? [];
}

/** The selection sent to `plan` and `install`. */
export function draftSelection(status: GentleAiApiStatus, draft: GentleAiSetupDraft) {
  const custom = draft.preset === CUSTOM_PRESET;
  return {
    agents: [...draft.agents],
    persona: draft.persona,
    preset: draft.preset,
    ...(custom ? { components: [...draftComponents(status, draft)] } : {}),
    ...(custom && draft.components.includes("skills") ? { skills: [...draft.skills] } : {}),
  };
}

const MODEL_QUESTIONS: ReadonlyArray<readonly [string, GentleAiModelAgent]> = [
  ["claudeModels", "claude-code"],
  ["codexModels", "codex"],
  ["kiroModels", "kiro-ide"],
  ["openCodeModels", "opencode"],
];

/** The agents whose models the plan asks about, in the TUI's order. */
export function plannedModelAgents(plan: GentleAiPlan | null): ReadonlyArray<GentleAiModelAgent> {
  if (plan === null) return [];
  return MODEL_QUESTIONS.filter(([question]) => plan.questions.includes(question)).map(
    ([, agent]) => agent,
  );
}

/**
 * The `install` params for a finished draft, asking only what the plan asks. Community tools are
 * left out: they are managed per project, and gentle-ai keeps the recorded ones when omitted.
 */
export function installParams(
  status: GentleAiApiStatus,
  draft: GentleAiSetupDraft,
  plan: GentleAiPlan,
): GentleAiInstallParams {
  const asks = (question: string) => plan.questions.includes(question);
  const modelPresets: Record<string, string> = {};
  const merged: { models?: GentleAiModels } = {};
  // Only agents the plan asks about; a choice left over from a deselected agent is dropped.
  for (const agent of plannedModelAgents(plan)) {
    const choice = draft.models[agent];
    if (choice === undefined) continue;
    if ("preset" in choice) modelPresets[agent] = choice.preset;
    else merged.models = Object.assign(merged.models ?? {}, choice.models);
  }
  const { models } = merged;
  return {
    selection: draftSelection(status, draft),
    ...(Object.keys(modelPresets).length > 0 ? { modelPresets } : {}),
    ...(models === undefined ? {} : { models }),
    ...(asks("openCodePlugins") ? { openCodePlugins: [...draft.openCodePlugins] } : {}),
    ...(asks("piPlugins") ? { piPlugins: [...draft.piPlugins] } : {}),
    ...(asks("rdd") ? { rdd: draft.rdd } : {}),
    ...(asks("openCodeBackground") || asks("piBackground")
      ? {
          background: {
            ...(asks("openCodeBackground") ? { opencode: draft.background.opencode } : {}),
            ...(asks("piBackground") ? { pi: draft.background.pi } : {}),
          },
        }
      : {}),
  };
}
