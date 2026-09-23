import type { PiGentleComposerState } from "@t3tools/contracts";

export interface GentleComposerAction {
  readonly label: string;
  readonly prompt: string | null;
  readonly kind: "setup" | "start" | "continue" | "blocked" | "select-change";
  readonly reason?: string;
}

const PHASE_LABELS = {
  propose: "proposal",
  spec: "specification",
  design: "design",
  tasks: "tasks",
  apply: "implementation",
  verify: "verification",
  remediate: "remediation",
  archive: "archive",
} as const;

const PHASE_DEPENDENCIES = {
  propose: "proposal",
  spec: "specs",
  design: "design",
  tasks: "tasks",
  apply: "apply",
  verify: "verify",
  archive: "archive",
} as const;

const blocked = (reason?: string): GentleComposerAction => ({
  kind: "blocked",
  label: "Review SDD status",
  prompt: null,
  ...(reason ? { reason } : {}),
});

export function gentleComposerAction(
  state: PiGentleComposerState,
  canInitialize = true,
): GentleComposerAction | null {
  const status = state.sddStatus;
  if (status === null) return null;
  if (state.projectInitNeeded) {
    return canInitialize
      ? { kind: "setup", label: "Set up SDD", prompt: "/gentle-sdd-init" }
      : blocked("This Gentle AI installation does not provide the SDD setup command.");
  }
  const next = status.nextRecommended;
  if (next === "sdd-new" || next === "archived") {
    return { kind: "start", label: "New SDD change", prompt: null };
  }
  if (next === "select-change") {
    return {
      kind: "select-change",
      label: "Choose SDD change",
      prompt: "Use Gentle SDD to continue. Help me select an existing change.",
    };
  }
  if (next === "resolve-blockers") return blocked(status.blockedReasons[0]);
  if (status.changeName === null) return blocked("Choose an SDD change before continuing.");
  if (status.actionContext.allowedEditRoots.length === 0) {
    return blocked("Gentle AI has not granted an editable project for this phase.");
  }
  if (status.blockedReasons.length > 0) return blocked(status.blockedReasons[0]);
  if (next === "remediate") {
    if (
      !status.remediationState?.required ||
      status.remediationState.complete ||
      !status.remediationState.failedEvidenceRevision
    ) {
      return blocked("Gentle AI has no remediation ready for this change.");
    }
  } else if (status.dependencies[PHASE_DEPENDENCIES[next]] !== "ready") {
    return blocked(`${PHASE_LABELS[next]} is waiting for a prerequisite.`);
  }
  return {
    kind: "continue",
    label: `Continue ${PHASE_LABELS[next]}`,
    prompt: `Continue Gentle SDD change ${JSON.stringify(status.changeName)} with its next permitted phase.`,
  };
}
