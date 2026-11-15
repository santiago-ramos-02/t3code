import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { DraftId } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import {
  advanceBoatDraft,
  type BoatDraftStart,
  failBoatDraft,
  machineStepsFor,
  startingBoatDraft,
  withMachineSteps,
} from "./boatDraftStart.logic";
import { connectAcquiredBoatMachine, waitForBoatProject } from "./boatMachine";
import { randomUUID } from "./utils";

/** The start in progress for each draft, shown above its composer until its thread exists. */
export const boatDraftStartAtom = Atom.family((_draftId: string) =>
  Atom.make<BoatDraftStart | null>(null).pipe(Atom.keepAlive),
);

function update(draftId: DraftId, change: (start: BoatDraftStart) => BoatDraftStart) {
  const atom = boatDraftStartAtom(draftId);
  const current = appAtomRegistry.get(atom);
  if (current) appAtomRegistry.set(atom, change(current));
}

/** Ends the draft's start, once its thread is created or it leaves Boat. */
export function clearBoatDraftStart(draftId: DraftId) {
  appAtomRegistry.set(boatDraftStartAtom(draftId), null);
}

/** Moves the draft's start on to the client's last step, which the send itself completes. */
export function markBoatDraftSending(draftId: DraftId) {
  update(draftId, (start) => advanceBoatDraft(start, "thread"));
}

/**
 * Has the host pick a Boat machine for the draft's repository and open it there, pairs this client
 * with the machine, and waits until the project can take a thread. Progress goes to the draft's
 * `boatDraftStartAtom`. Returns the project on the machine, or null when the start failed, with
 * the reason in that progress, or was interrupted.
 */
export async function startBoatDraft(input: {
  readonly draftId: DraftId;
  readonly hostEnvironmentId: EnvironmentId;
  readonly remoteUrl: string;
  readonly branch: string;
  /** The repository's name, shown on its row. */
  readonly repository: string | null;
}): Promise<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null> {
  const { draftId } = input;
  const startId = randomUUID();
  appAtomRegistry.set(boatDraftStartAtom(draftId), startingBoatDraft(input.repository));
  const fail = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "An error occurred.";
    update(draftId, (start) => failBoatDraft(start, message));
    return null;
  };

  // The host reports the picked machine's steps under the start id until the acquire returns.
  const stopWatching = appAtomRegistry.subscribe(
    serverEnvironment.boatStatus({ environmentId: input.hostEnvironmentId, input: {} }),
    (result) => {
      const machines = Option.getOrNull(AsyncResult.value(result))?.machines ?? [];
      const steps = machineStepsFor(machines, startId);
      if (steps) update(draftId, (start) => withMachineSteps(start, steps));
    },
  );
  const acquired = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.acquireBoatMachine,
    {
      environmentId: input.hostEnvironmentId,
      input: { remoteUrl: input.remoteUrl, branch: input.branch, startId },
    },
    { label: "Start on Boat", reportFailure: false },
  ).finally(stopWatching);
  if (acquired._tag === "Failure") {
    if (isAtomCommandInterrupted(acquired)) {
      clearBoatDraftStart(draftId);
      return null;
    }
    const error = squashAtomCommandFailure(acquired);
    return fail(error instanceof Error ? error : new Error("The Boat machine did not start."));
  }
  update(draftId, (start) => advanceBoatDraft(start, "connect"));

  const { machine, httpBaseUrl, pairingCredential, projectId } = acquired.value;
  try {
    const environmentId = await connectAcquiredBoatMachine({
      sandboxId: machine.sandboxId,
      httpBaseUrl,
      pairingCredential,
    });
    update(draftId, (start) => advanceBoatDraft(start, "project"));
    await waitForBoatProject({ environmentId, projectId });
    return { environmentId, projectId };
  } catch (cause) {
    return fail(cause);
  }
}
