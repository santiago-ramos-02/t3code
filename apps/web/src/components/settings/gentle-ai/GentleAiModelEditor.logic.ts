import type {
  GentleAiModelAgent,
  GentleAiModelConfig,
  GentleAiModels,
  GentleAiOpenCodeModel,
} from "@t3tools/contracts";

type Phase = GentleAiModelConfig["phases"][number];
/** Agents whose phases pick from a fixed model list rather than OpenCode's providers. */
export type GentleAiFixedModelAgent = Exclude<GentleAiModelAgent, "opencode">;

const GROUP_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  odd: "ODD",
  "judgment-day": "Judgment Day",
  review: "RDD review",
  general: "General",
  native: "Native agents",
  custom: "Custom agents",
};
const GROUP_ORDER = Object.keys(GROUP_LABELS);

/** Phases grouped as the TUI shows them; groups gentle-ai adds later follow, in its order. */
export function groupPhases(phases: ReadonlyArray<Phase>) {
  const groups = new Map<string, Phase[]>();
  for (const phase of phases) {
    const members = groups.get(phase.group);
    if (members) members.push(phase);
    else groups.set(phase.group, [phase]);
  }
  const rank = (group: string) => {
    const index = GROUP_ORDER.indexOf(group);
    return index === -1 ? GROUP_ORDER.length : index;
  };
  return [...groups]
    .toSorted(([a], [b]) => rank(a) - rank(b))
    .map(([id, members]) => ({ id, label: GROUP_LABELS[id] ?? id, phases: members }));
}

/** One phase's model and effort; an absent field is gentle-ai's default. */
export interface PhaseChoice {
  readonly model?: string;
  readonly effort?: string;
}

/** A PhaseChoice from possibly-undefined parts. */
export const phaseChoice = (
  model: string | undefined,
  effort: string | undefined,
): PhaseChoice => ({
  ...(model === undefined ? {} : { model }),
  ...(effort === undefined ? {} : { effort }),
});

/** A copy of `map` with `key` set to `next`, or removed when `next` is undefined. */
function withKey<T>(
  map: Readonly<Record<string, T>> | undefined,
  key: string,
  next: T | undefined,
): Record<string, T> {
  const { [key]: _removed, ...rest } = map ?? {};
  return next === undefined ? rest : { ...rest, [key]: next };
}

export function readPhase(
  agent: GentleAiFixedModelAgent,
  value: GentleAiModels,
  phase: string,
): PhaseChoice {
  switch (agent) {
    case "claude-code":
      return value.claudePhaseAssignments?.[phase] ?? {};
    case "kiro-ide":
      return phaseChoice(value.kiroModelAssignments?.[phase], undefined);
    case "codex":
      return phaseChoice(
        value.codexPhaseModelAssignments?.[phase],
        value.codexModelAssignments?.[phase],
      );
  }
}

export function writePhase(
  agent: GentleAiFixedModelAgent,
  value: GentleAiModels,
  phase: string,
  next: PhaseChoice,
): GentleAiModels {
  switch (agent) {
    case "claude-code":
      // Claude assigns a model and its effort together; no model means the default for both.
      return {
        ...value,
        claudePhaseAssignments: withKey(
          value.claudePhaseAssignments,
          phase,
          next.model === undefined
            ? undefined
            : { model: next.model, ...phaseChoice(undefined, next.effort) },
        ),
      };
    case "kiro-ide":
      return {
        ...value,
        kiroModelAssignments: withKey(value.kiroModelAssignments, phase, next.model),
      };
    case "codex":
      return {
        ...value,
        codexPhaseModelAssignments: withKey(value.codexPhaseModelAssignments, phase, next.model),
        codexModelAssignments: withKey(value.codexModelAssignments, phase, next.effort),
      };
  }
}

/** Assigns one OpenCode model to every listed phase, or returns them to the default. */
export function writeOpenCodePhases(
  value: GentleAiModels,
  phases: ReadonlyArray<string>,
  next: GentleAiOpenCodeModel | null,
): GentleAiModels {
  let assignments = value.modelAssignments;
  for (const phase of phases) assignments = withKey(assignments, phase, next ?? undefined);
  return { ...value, modelAssignments: assignments ?? {} };
}

/** The fields the editor owns for `agent`, ready for `models.set`. Other agents stay untouched. */
export function agentModels(agent: GentleAiModelAgent, value: GentleAiModels): GentleAiModels {
  switch (agent) {
    case "claude-code":
      return { claudePhaseAssignments: value.claudePhaseAssignments ?? {} };
    case "kiro-ide":
      return { kiroModelAssignments: value.kiroModelAssignments ?? {} };
    case "codex":
      return {
        codexPhaseModelAssignments: value.codexPhaseModelAssignments ?? {},
        codexModelAssignments: value.codexModelAssignments ?? {},
      };
    case "opencode":
      return { modelAssignments: value.modelAssignments ?? {} };
  }
}

/** Every model choice gentle-ai keeps for `agent`, back to its defaults. */
export function resetAgentModels(agent: GentleAiModelAgent): GentleAiModels {
  switch (agent) {
    case "claude-code":
      return { claudePhaseAssignments: {}, claudeModelAssignments: {} };
    case "kiro-ide":
      return { kiroModelAssignments: {} };
    case "codex":
      return {
        codexPhaseModelAssignments: {},
        codexModelAssignments: {},
        codexCarrilModelAssignments: {},
        clearCodexOrchestratorAssignment: true,
      };
    case "opencode":
      return { modelAssignments: {} };
  }
}

/**
 * The models a Claude Code phase can run on. General delegation passes its model with each
 * Agent tool call, which takes only Claude's tiers, so models a proxy serves (`custom:`
 * choices) are offered to the named worker and review phases only.
 */
export function claudePhaseModelOptions<Model extends { readonly id: string }>(
  models: ReadonlyArray<Model>,
  phaseId: string,
): ReadonlyArray<Model> {
  return phaseId === "default" ? models.filter((model) => !model.id.startsWith("custom:")) : models;
}

export function formatOpenCodeModel(model: GentleAiOpenCodeModel): string {
  return `${model.providerId}/${model.modelId}${model.effort ? ` · ${model.effort}` : ""}`;
}
