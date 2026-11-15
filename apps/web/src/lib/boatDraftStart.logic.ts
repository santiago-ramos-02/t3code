import {
  BOAT_DRAFT_START_STEPS,
  boatDraftBlocker,
  type BoatDraftBlocker,
  type BoatDraftStartProgress,
  type BoatDraftStartStep,
} from "@t3tools/client-runtime/boat";
import type { BoatMachine, BoatStartStep, BoatStatus } from "@t3tools/contracts";

import type { DraftSessionState } from "../composerDraftStore";

/** A Boat draft's start as the client shows it: the shared progress, and why it stopped. */
export interface BoatDraftStart extends BoatDraftStartProgress {
  readonly error: string | null;
}

export function startingBoatDraft(repository: string | null): BoatDraftStart {
  return { step: "machine", failed: false, error: null, machineSteps: [], repository };
}

/**
 * The steps the host reports for the machine its acquire picked, which carries the start id. The
 * host clears them once the start is over, so an empty list is no news.
 */
export function machineStepsFor(
  machines: ReadonlyArray<Pick<BoatMachine, "startId" | "startSteps">>,
  startId: string,
): ReadonlyArray<BoatStartStep> | null {
  const steps = machines.find((machine) => machine.startId === startId)?.startSteps;
  return steps && steps.length > 0 ? steps : null;
}

/** Takes the host's latest steps while the host is still on the machine step. */
export function withMachineSteps(
  start: BoatDraftStart,
  steps: ReadonlyArray<BoatStartStep>,
): BoatDraftStart {
  if (start.step !== "machine" || start.failed) return start;
  const unchanged =
    steps.length === start.machineSteps.length &&
    steps.every((step, index) => step === start.machineSteps[index]);
  return unchanged ? start : { ...start, machineSteps: steps };
}

/** Moves on to `step`; a step already reached, or a start that failed, stays as it is. */
export function advanceBoatDraft(start: BoatDraftStart, step: BoatDraftStartStep): BoatDraftStart {
  if (start.failed) return start;
  return BOAT_DRAFT_START_STEPS.indexOf(step) > BOAT_DRAFT_START_STEPS.indexOf(start.step)
    ? { ...start, step }
    : start;
}

export function failBoatDraft(start: BoatDraftStart, error: string): BoatDraftStart {
  return { ...start, failed: true, error };
}

type DraftForBoatSend = Pick<
  DraftSessionState,
  "environmentId" | "projectId" | "environmentSelection" | "promotedTo" | "branch"
>;

export type BoatDraftSendPlan =
  | { readonly kind: "drop" }
  /** The draft already sits on its Boat machine, such as after a send that failed. */
  | { readonly kind: "send" }
  | { readonly kind: "blocked"; readonly blocker: BoatDraftBlocker }
  | { readonly kind: "start"; readonly remoteUrl: string; readonly branch: string };

/** What the first send of a draft does about Boat, before anything starts. */
export function planBoatDraftSend(input: {
  readonly draft: DraftForBoatSend | null;
  readonly onBoatMachine: boolean;
  readonly status: BoatStatus | null;
  readonly remoteUrl: string | null;
}): BoatDraftSendPlan {
  const { draft, remoteUrl } = input;
  if (!draft || draft.promotedTo || draft.environmentSelection !== "boat") return { kind: "drop" };
  if (input.onBoatMachine) return { kind: "send" };
  const blocker = boatDraftBlocker({
    status: input.status,
    remoteUrl,
    baseBranch: draft.branch ?? null,
  });
  if (blocker) return { kind: "blocked", blocker };
  // The blocker is null only when both are set.
  return { kind: "start", remoteUrl: remoteUrl ?? "", branch: draft.branch ?? "" };
}

/**
 * Whether the draft is still the one the start began for. A start takes up to a minute, and the
 * draft may have been sent, moved to another machine, or taken off Boat meanwhile.
 */
export function boatDraftStillCurrent(
  started: DraftForBoatSend,
  current: DraftForBoatSend | null,
): boolean {
  return (
    current !== null &&
    !current.promotedTo &&
    current.environmentSelection === "boat" &&
    current.environmentId === started.environmentId &&
    current.projectId === started.projectId
  );
}
