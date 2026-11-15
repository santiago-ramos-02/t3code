import type {
  BoatMachine,
  BoatStartStep,
  BoatStatus,
  ProviderDriverKind,
} from "@t3tools/contracts";

/** The rows a client shows while a Boat draft's first send finds a machine and opens it there. */
export const BOAT_DRAFT_START_STEPS = [
  "machine",
  "repository",
  "connect",
  "project",
  "thread",
] as const;
export type BoatDraftStartStep = (typeof BOAT_DRAFT_START_STEPS)[number];

const BOAT_DRAFT_START_LABELS: Readonly<Record<BoatDraftStartStep, string>> = {
  machine: "Find a machine",
  repository: "Clone or update the repository",
  connect: "Connect",
  project: "Open the project",
  thread: "Start the thread",
};

const MACHINE_STEP_DETAILS: Readonly<Record<Exclude<BoatStartStep, "cloning">, string>> = {
  starting: "Starting a machine",
  installing: "Installing T3 Code",
  "signing-in": "Signing in to GitHub",
};

export type BoatDraftStartRowState = "pending" | "active" | "done" | "failed";

export interface BoatDraftStartRow {
  readonly step: BoatDraftStartStep;
  readonly label: string;
  readonly state: BoatDraftStartRowState;
  readonly detail: string | null;
}

export interface BoatDraftStartProgress {
  /** The step the client is on; the host's `cloning` step moves `machine` on to `repository`. */
  readonly step: BoatDraftStartStep;
  readonly failed: boolean;
  /** The steps the host reported for the machine it picked, in order. */
  readonly machineSteps: ReadonlyArray<BoatStartStep>;
  /** The repository being opened, shown on its row. */
  readonly repository: string | null;
}

export function boatDraftStartRows(progress: BoatDraftStartProgress): BoatDraftStartRow[] {
  const lastMachineStep = progress.machineSteps.at(-1);
  const current =
    progress.step === "machine" && lastMachineStep === "cloning" ? "repository" : progress.step;
  const currentIndex = BOAT_DRAFT_START_STEPS.indexOf(current);
  return BOAT_DRAFT_START_STEPS.map((step, index) => {
    const state: BoatDraftStartRowState =
      index < currentIndex
        ? "done"
        : index > currentIndex
          ? "pending"
          : progress.failed
            ? "failed"
            : "active";
    const detail =
      step === "machine" &&
      state !== "done" &&
      lastMachineStep !== undefined &&
      lastMachineStep !== "cloning"
        ? MACHINE_STEP_DETAILS[lastMachineStep]
        : step === "repository"
          ? progress.repository
          : null;
    return { step, label: BOAT_DRAFT_START_LABELS[step], state, detail };
  });
}

export interface BoatDraftBlocker {
  readonly title: string;
  readonly description: string;
}

/** Why a Boat draft cannot be sent yet, checked before any machine starts. */
export function boatDraftBlocker(input: {
  readonly status: BoatStatus | null;
  readonly remoteUrl: string | null;
  readonly baseBranch: string | null;
}): BoatDraftBlocker | null {
  if (input.status === null || !input.status.configured) {
    return {
      title: "Boat is not set up",
      description: "Connect Boat in Settings, Connections.",
    };
  }
  if (input.remoteUrl === null || input.remoteUrl.trim() === "") {
    return {
      title: "Boat needs a git remote",
      description: "Push this project to a remote Boat can clone.",
    };
  }
  if (input.baseBranch === null || input.baseBranch.trim() === "") {
    return { title: "Choose a base branch", description: "Boat starts a new worktree from it." };
  }
  return null;
}

/**
 * The providers a Boat draft can use: those ready on any machine that reported them. Null when no
 * machine has reported yet, so nothing is hidden on a guess.
 */
export function boatReadyProviders(
  status: BoatStatus | null,
): ReadonlySet<ProviderDriverKind> | null {
  const reported = (status?.machines ?? []).flatMap((machine) => machine.report?.providers ?? []);
  return reported.length === 0 ? null : new Set(reported);
}

/** Whether a saved environment's address is this Boat machine's. */
export function isBoatMachineAt(
  machine: Pick<BoatMachine, "httpBaseUrl">,
  httpBaseUrl: string | null,
): boolean {
  const origin = httpBaseUrl ? originOf(httpBaseUrl) : null;
  return (
    origin !== null && machine.httpBaseUrl !== null && originOf(machine.httpBaseUrl) === origin
  );
}

/** The Boat machine a saved environment was paired to, matched by its address. */
export function boatMachineAt(
  status: BoatStatus | null,
  httpBaseUrl: string | null,
): BoatMachine | null {
  return status?.machines.find((machine) => isBoatMachineAt(machine, httpBaseUrl)) ?? null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
