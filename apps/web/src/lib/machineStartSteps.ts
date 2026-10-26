import {
  projectCloneProgressSummary,
  type BoatMachine,
  type BoatStartStep,
  type ProjectCloneSnapshot,
} from "@t3tools/contracts";

/** The host reports the start steps; connecting is this client pairing with the new machine. */
export type MachineStartStep = BoatStartStep | "connecting";

const STEP_LABELS: Record<MachineStartStep, string> = {
  starting: "Starting machine",
  installing: "Installing T3 Code",
  "signing-in": "Signing in to GitHub",
  connecting: "Connecting",
};

/** The steps of the machine whose start carried `startId`, or null until the host lists it. */
export function startStepsFor(
  machines: ReadonlyArray<Pick<BoatMachine, "state" | "startId" | "startSteps">>,
  startId: string,
): ReadonlyArray<BoatStartStep> | null {
  const machine = machines.find((m) => m.state === "starting" && m.startId === startId);
  return machine?.startSteps ?? null;
}

export interface MachineStartRow {
  readonly id: string;
  readonly label: string;
  readonly status: "pending" | "running" | "done" | "failed";
  readonly detail: string | null;
}

/**
 * The rows for adding a project to another machine: the start steps taken so far (none for a
 * machine that is already running), then the clone. The step a failure stopped on is the last one.
 */
export function machineStartRows(input: {
  readonly steps: ReadonlyArray<MachineStartStep>;
  readonly phase: "machine" | "clone";
  readonly failed: boolean;
  readonly clone: ProjectCloneSnapshot | null;
}): ReadonlyArray<MachineStartRow> {
  const machineRows = input.steps.map((step, index): MachineStartRow => ({
    id: step,
    label: STEP_LABELS[step],
    status:
      input.phase === "machine" && index === input.steps.length - 1
        ? input.failed
          ? "failed"
          : "running"
        : "done",
    detail: null,
  }));
  return [...machineRows, cloneRow(input)];
}

function cloneRow(input: {
  readonly phase: "machine" | "clone";
  readonly failed: boolean;
  readonly clone: ProjectCloneSnapshot | null;
}): MachineStartRow {
  const row = { id: "clone", label: "Clone repository" } as const;
  if (input.phase === "machine") return { ...row, status: "pending", detail: null };
  const { clone } = input;
  if (clone === null) {
    return { ...row, status: input.failed ? "failed" : "running", detail: null };
  }
  switch (clone.phase) {
    case "running":
      return { ...row, status: "running", detail: projectCloneProgressSummary(clone) };
    case "done":
      return { ...row, status: "done", detail: null };
    case "failed":
      return { ...row, status: "failed", detail: null };
    case "cancelled":
      return { ...row, status: "failed", detail: "Cancelled" };
  }
}
