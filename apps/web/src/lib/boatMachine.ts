import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { BoatSize, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { startStepsFor, type MachineStartStep } from "./machineStartSteps";
import { randomUUID } from "./utils";

// Pairing finishes before the first connection; a machine that does not connect by then is broken.
const CONNECT_TIMEOUT_MS = 60_000;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/** Resolves once the environment is connected and has sent its config. */
function waitForConnection(environmentId: EnvironmentId) {
  return new Promise<EnvironmentPresentation>((resolve, reject) => {
    const atom = environmentPresentations.presentationsAtom;
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const timeout = setTimeout(() => {
      settle();
      reject(new Error("The Boat machine started but did not connect within a minute."));
    }, CONNECT_TIMEOUT_MS);
    const settle = () => {
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
    };
    const check = (presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>) => {
      const presentation = presentations.get(environmentId);
      if (settled || presentation?.connection.phase !== "connected" || !presentation.serverConfig) {
        return;
      }
      settle();
      resolve(presentation);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    check(appAtomRegistry.get(atom));
  });
}

/**
 * Reports the start steps of the machine whose start carried `startId`, as the host's status
 * stream says them, so every client sees the same steps. Returns the way to stop watching.
 */
function watchStartSteps(
  hostEnvironmentId: EnvironmentId,
  startId: string,
  onSteps: (steps: ReadonlyArray<MachineStartStep>) => void,
): () => void {
  const atom = serverEnvironment.boatStatus({ environmentId: hostEnvironmentId, input: {} });
  return appAtomRegistry.subscribe(atom, (result) => {
    const machines = Option.getOrNull(AsyncResult.value(result))?.machines ?? [];
    const steps = startStepsFor(machines, startId);
    if (steps) onSteps(steps);
  });
}

/**
 * Starts a Boat machine from the host environment, pairs this client with it, and resolves once
 * it is connected. `onSteps` gets the steps taken so far each time they change. A machine this
 * client could not pair with is deleted, since nothing else can reach it and it bills while it
 * runs.
 */
export async function startBoatMachine(input: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly size: BoatSize;
  // The host's project the machine is for, whose worktree cleanup rules then apply to it.
  readonly projectId: ProjectId | null;
  readonly onSteps: (steps: ReadonlyArray<MachineStartStep>) => void;
}): Promise<{ readonly environmentId: EnvironmentId; readonly label: string }> {
  input.onSteps(["starting"]);
  const startId = randomUUID();
  const stopWatching = watchStartSteps(input.hostEnvironmentId, startId, input.onSteps);
  const spawned = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.spawnBoatMachine,
    {
      environmentId: input.hostEnvironmentId,
      input: {
        size: input.size,
        startId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
    },
    { label: "Start Boat machine", reportFailure: false },
  ).finally(stopWatching);
  if (spawned._tag === "Failure") throw new Error(failureMessage(spawned));

  const { machine, httpBaseUrl, pairingCredential } = spawned.value;
  input.onSteps([...machine.startSteps, "connecting"]);
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    { host: httpBaseUrl, pairingCode: pairingCredential },
    { label: "Pair with Boat machine", reportFailure: false },
  );
  if (paired._tag === "Failure") {
    await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.runBoatMachineAction,
      {
        environmentId: input.hostEnvironmentId,
        input: { sandboxId: machine.sandboxId, action: "delete" },
      },
      { label: "Delete unpaired Boat machine", reportFailure: false },
    );
    throw new Error(`Could not pair with the Boat machine: ${failureMessage(paired)}`);
  }
  const presentation = await waitForConnection(paired.value);
  return { environmentId: paired.value, label: presentation.entry.target.label };
}

// One resume per machine, however many threads or sends ask for it.
const wakes = new Map<string, Promise<void>>();

/**
 * Resumes a stopped Boat machine from the host environment and resolves once this client is
 * connected to it again.
 */
export function wakeBoatMachine(input: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
  readonly sandboxId: string;
}): Promise<void> {
  const pending = wakes.get(input.sandboxId);
  if (pending) return pending;
  const wake = (async () => {
    const resumed = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.runBoatMachineAction,
      {
        environmentId: input.hostEnvironmentId,
        input: { sandboxId: input.sandboxId, action: "resume" },
      },
      { label: "Resume Boat machine", reportFailure: false },
    );
    if (resumed._tag === "Failure") throw new Error(failureMessage(resumed));
    // The connection backs off while the machine is stopped; it reconnects now instead.
    await runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, input.environmentId, {
      label: "Reconnect to Boat machine",
      reportFailure: false,
    });
    await waitForConnection(input.environmentId);
  })().finally(() => wakes.delete(input.sandboxId));
  wakes.set(input.sandboxId, wake);
  return wake;
}
