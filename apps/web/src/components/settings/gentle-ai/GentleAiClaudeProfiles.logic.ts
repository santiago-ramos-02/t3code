import type {
  GentleAiClaudeProfile,
  GentleAiClaudeSlot,
  GentleAiModelConfig,
  GentleAiModels,
} from "@t3tools/contracts";

// gentle-ai's prefix for a model Claude Code reaches by ID rather than a slot name.
const CUSTOM = "custom:";

/**
 * The models a slot can run: every model the proxy Claude Code is connected to serves, by
 * the ID Claude Code sends. Without a proxy there are none; slots then stay Claude Code's own.
 */
export function claudeSlotModelOptions(config: GentleAiModelConfig | null) {
  return (config?.options.claude?.models ?? []).flatMap((model) =>
    model.id.startsWith(CUSTOM) ? [{ id: model.id.slice(CUSTOM.length), label: model.label }] : [],
  );
}

/** Sets what one slot runs, carrying the model's name along; null leaves the slot as it is. */
export function withSlotModel(
  profile: GentleAiClaudeProfile,
  slot: GentleAiClaudeSlot,
  model: { readonly id: string; readonly label: string } | null,
): GentleAiClaudeProfile {
  const { [slot]: previous, ...others } = profile.slots;
  if (model === null) return { ...profile, slots: others };
  return {
    ...profile,
    slots: {
      ...others,
      [slot]: {
        model: model.id,
        label: model.label,
        ...(previous?.useFor === undefined ? {} : { useFor: previous.useFor }),
      },
    },
  };
}

/** Sets what the orchestrator should use a slot for; empty text removes the note. */
export function withSlotUse(
  profile: GentleAiClaudeProfile,
  slot: GentleAiClaudeSlot,
  useFor: string,
): GentleAiClaudeProfile {
  const current = profile.slots[slot];
  if (current === undefined) return profile;
  const { useFor: _previous, ...rest } = current;
  const text = useFor.replace(/[\n\r|]/g, " ");
  return {
    ...profile,
    slots: { ...profile.slots, [slot]: text.trim() === "" ? rest : { ...rest, useFor: text } },
  };
}

/** The profile's pinned phases in the model editor's shape. */
export function profilePhaseModels(profile: GentleAiClaudeProfile): GentleAiModels {
  return { claudePhaseAssignments: profile.phases ?? {} };
}

/** Pins what the model editor chose; with nothing chosen, the orchestrator picks every model. */
export function withPhaseModels(
  profile: GentleAiClaudeProfile,
  models: GentleAiModels | null,
): GentleAiClaudeProfile {
  const { phases: _previous, ...rest } = profile;
  const phases = models?.claudePhaseAssignments ?? {};
  return Object.keys(phases).length === 0 ? rest : { ...rest, phases };
}
