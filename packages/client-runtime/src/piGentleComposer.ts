import type { PiGentleSddStatus } from "@t3tools/contracts";

export interface GentleComposerAction {
  readonly label: string;
  readonly draft: string | null;
  readonly kind: "start" | "continue" | "blocked" | "select-change";
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

export function gentleComposerAction(status: PiGentleSddStatus): GentleComposerAction | null {
  const next = status.nextRecommended;
  if (next === "sdd-new" || next === "archived") {
    return { kind: "start", label: "Start SDD", draft: "Use Gentle SDD to " };
  }
  if (next === "select-change") {
    return {
      kind: "select-change",
      label: "Choose SDD change",
      draft: "Use Gentle SDD to continue. Help me select an existing change.",
    };
  }
  if (next === "resolve-blockers") {
    return { kind: "blocked", label: "Review SDD blockers", draft: null };
  }
  if (status.changeName === null) return null;
  return {
    kind: "continue",
    label: `Continue ${PHASE_LABELS[next]}`,
    draft: `Continue Gentle SDD change ${JSON.stringify(status.changeName)} with its next permitted phase.`,
  };
}
