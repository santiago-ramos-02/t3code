import type {
  ModelSelection,
  PiGentleComposerState,
  PiGentleSddChange,
  ServerProviderModel,
} from "@t3tools/contracts";

export type GentleProfileOption = NonNullable<PiGentleComposerState["profiles"]>[number];

/**
 * What applying a Gentle profile does to a Pi thread's model: Gentle AI switches the live
 * session to the profile's orchestrator, so the thread moves to that model and thinking level.
 * A profile without an orchestrator keeps the thread's model; one Pi does not list is reported.
 */
export type GentleProfileModelChange =
  | { readonly kind: "keep" }
  | { readonly kind: "switch"; readonly selection: ModelSelection; readonly label: string }
  | { readonly kind: "unavailable"; readonly model: string };

export function gentleProfileModelChange(
  current: ModelSelection,
  profile: GentleProfileOption,
  models: ReadonlyArray<ServerProviderModel>,
): GentleProfileModelChange {
  const slug = profile.orchestrator?.model;
  if (slug === undefined) return { kind: "keep" };
  const model = models.find((entry) => entry.slug === slug);
  if (model === undefined) return { kind: "unavailable", model: slug };
  const thinking = profile.orchestrator?.thinking;
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (entry) => entry.id === "thinkingLevel",
  );
  const thinkingOption =
    descriptor?.type === "select"
      ? descriptor.options.find((option) => option.id === thinking)
      : undefined;
  // The profile's thinking level replaces the thread's; one the model lacks falls to its default.
  const options = [
    ...(current.options?.filter((option) => option.id !== "thinkingLevel") ?? []),
    ...(thinkingOption === undefined ? [] : [{ id: "thinkingLevel", value: thinkingOption.id }]),
  ];
  return {
    kind: "switch",
    selection: {
      instanceId: current.instanceId,
      model: model.slug,
      ...(options.length === 0 ? {} : { options }),
    },
    label: [model.shortName ?? model.name, thinkingOption?.label].filter(Boolean).join(" · "),
  };
}

/** Menu detail for a profile: the model applying it moves the thread to. */
export function gentleProfileModelLabel(
  current: ModelSelection,
  profile: GentleProfileOption,
  models: ReadonlyArray<ServerProviderModel>,
): string {
  const change = gentleProfileModelChange(current, profile, models);
  if (change.kind === "switch") return change.label;
  return change.kind === "unavailable" ? `${change.model} unavailable` : "Keeps model";
}

// Gentle AI runs SDD phases back to back in auto mode. Planning stops after tasks so only the
// user starts apply, from their own message or the change's Implement action.
const STOP_BEFORE_APPLY = "Stop after tasks; do not start apply until I say so.";

/** Draft for a new SDD change; the user finishes the sentence with the goal. */
export const GENTLE_SDD_NEW_CHANGE_PROMPT = `Use SDD to propose a new OpenSpec change and plan it through tasks. ${STOP_BEFORE_APPLY} The change is: `;

/**
 * What a client can do next with one SDD change: start the ready phase in a Gentle-enabled Pi
 * thread, wait on a blocker, or nothing because the change is archived.
 */
export type GentleSddChangeStep =
  | {
      readonly kind: "ready";
      readonly label: string;
      /** Instruction for a new Gentle-enabled Pi thread that runs this phase. */
      readonly prompt: string;
    }
  | { readonly kind: "blocked"; readonly label: string; readonly reason: string }
  | { readonly kind: "done"; readonly label: string };

type SddPhase = Extract<
  PiGentleSddChange["nextRecommended"],
  "propose" | "spec" | "design" | "tasks" | "apply" | "verify" | "remediate" | "archive"
>;

const PHASES = {
  propose: { name: "proposal", action: "Write proposal", dependency: "proposal", planning: true },
  spec: { name: "spec", action: "Write specs", dependency: "specs", planning: true },
  design: { name: "design", action: "Write design", dependency: "design", planning: true },
  tasks: { name: "tasks", action: "Plan tasks", dependency: "tasks", planning: true },
  apply: { name: "apply", action: "Implement", dependency: "apply", planning: false },
  verify: { name: "verify", action: "Verify", dependency: "verify", planning: false },
  remediate: {
    name: "remediate",
    action: "Fix verification findings",
    dependency: null,
    planning: false,
  },
  archive: { name: "archive", action: "Archive", dependency: "archive", planning: false },
} as const satisfies Record<
  SddPhase,
  {
    name: string;
    action: string;
    dependency: keyof PiGentleSddChange["dependencies"] | null;
    planning: boolean;
  }
>;

const blocked = (label: string, reason: string): GentleSddChangeStep => ({
  kind: "blocked",
  label,
  reason,
});

/** Resolves the next step for a change from Gentle AI's native status, never from task counts. */
export function gentleSddChangeStep(change: PiGentleSddChange): GentleSddChangeStep {
  const next = change.nextRecommended;
  if (next === "archived") return { kind: "done", label: "Archived" };
  if (next === "resolve-blockers") {
    return blocked("Blocked", change.blockedReasons[0] ?? "Gentle AI reported a blocker.");
  }
  if (next === "sdd-new" || next === "select-change") {
    return blocked("Unavailable", "Gentle AI could not resolve this change.");
  }
  const phase = PHASES[next];
  if (change.actionContext.allowedEditRoots.length === 0) {
    return blocked(phase.action, "Gentle AI has not granted an editable project for this phase.");
  }
  const blocker = change.blockedReasons[0];
  if (blocker !== undefined) return blocked(phase.action, blocker);
  // Remediation has no dependency entry; it is ready only while a failed verification awaits a fix.
  if (phase.dependency === null) {
    const remediation = change.remediationState;
    if (!remediation?.required || remediation.complete || !remediation.failedEvidenceRevision) {
      return blocked(phase.action, "Gentle AI has no remediation ready for this change.");
    }
  } else if (change.dependencies[phase.dependency] !== "ready") {
    return blocked(phase.action, "Waiting for an earlier phase.");
  }
  return {
    kind: "ready",
    label: phase.action,
    // SDD only starts from an explicit request, so the prompt names the workflow, change, and
    // phase. It leads with them because the thread title is seeded from the first message.
    prompt: phase.planning
      ? `SDD ${change.changeName}: run the ${phase.name} phase. Continue planning the OpenSpec change \`${change.changeName}\` through tasks. ${STOP_BEFORE_APPLY}`
      : `SDD ${change.changeName}: run the ${phase.name} phase. Continue the SDD workflow for the OpenSpec change \`${change.changeName}\`.`,
  };
}

/** "1 of 3 tasks" once a change has a task plan, otherwise null. */
export function gentleSddTaskSummary(change: PiGentleSddChange): string | null {
  const { total, completed } = change.taskProgress;
  return total > 0 ? `${completed} of ${total} tasks` : null;
}
