import type { PiGentleSddChange } from "@t3tools/contracts";

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
  propose: { name: "proposal", action: "Write proposal", dependency: "proposal" },
  spec: { name: "spec", action: "Write specs", dependency: "specs" },
  design: { name: "design", action: "Write design", dependency: "design" },
  tasks: { name: "tasks", action: "Plan tasks", dependency: "tasks" },
  apply: { name: "apply", action: "Implement", dependency: "apply" },
  verify: { name: "verify", action: "Verify", dependency: "verify" },
  remediate: { name: "remediate", action: "Fix verification findings", dependency: null },
  archive: { name: "archive", action: "Archive", dependency: "archive" },
} as const satisfies Record<
  SddPhase,
  {
    name: string;
    action: string;
    dependency: keyof PiGentleSddChange["dependencies"] | null;
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
    prompt: `SDD ${change.changeName}: run the ${phase.name} phase. Continue the SDD workflow for the OpenSpec change \`${change.changeName}\`.`,
  };
}

/** "1 of 3 tasks" once a change has a task plan, otherwise null. */
export function gentleSddTaskSummary(change: PiGentleSddChange): string | null {
  const { total, completed } = change.taskProgress;
  return total > 0 ? `${completed} of ${total} tasks` : null;
}
