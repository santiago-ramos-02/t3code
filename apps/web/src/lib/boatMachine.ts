import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { isBoatMachineAt } from "@t3tools/client-runtime/boat";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type BoatSize,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { environmentProjects } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { environmentSession, sessionHasScope } from "../state/session";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { startStepsFor, type MachineStartStep } from "./machineStartSteps";
import { randomUUID } from "./utils";

// Pairing finishes before the first connection; a machine that does not connect by then is broken.
const CONNECT_TIMEOUT_MS = 60_000;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Resolves once the environment is connected and has sent its config. `timeoutMessage` says what
 * state the machine is in when it does not, since only the caller knows.
 */
function waitForConnection(environmentId: EnvironmentId, timeoutMessage: string) {
  return new Promise<EnvironmentPresentation>((resolve, reject) => {
    const atom = environmentPresentations.presentationsAtom;
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const timeout = setTimeout(() => {
      settle();
      reject(new Error(timeoutMessage));
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
    throw new Error(
      `Could not pair with the Boat machine, so it was deleted: ${failureMessage(paired)}`,
    );
  }
  // It paired, so it is kept: it is running and billing, and the user can stop it from Settings.
  const presentation = await waitForConnection(
    paired.value,
    "The Boat machine started and paired, but this client did not reach it within a minute. It is still running; check it in Settings, Connections.",
  );
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
    await waitForConnection(
      input.environmentId,
      "The Boat machine resumed, but this client did not reach it within a minute. It is running; try Resume again.",
    );
    // The message that wakes it is sent right after, and its send needs the grant, which loads
    // just after the connection does.
    await waitForOperateGrant(input.environmentId);
  })().finally(() => wakes.delete(input.sandboxId));
  wakes.set(input.sandboxId, wake);
  return wake;
}

// One pairing per machine, however many places ask for it.
const pairings = new Map<string, Promise<EnvironmentId>>();

function pairOnce(sandboxId: string, pair: () => Promise<EnvironmentId>): Promise<EnvironmentId> {
  const pending = pairings.get(sandboxId);
  if (pending) return pending;
  const pairing = pair().finally(() => pairings.delete(sandboxId));
  pairings.set(sandboxId, pairing);
  return pairing;
}

/** Pairs with a machine's server using a credential the host minted, and waits for the connection. */
async function pairWithCredential(input: {
  readonly httpBaseUrl: string;
  readonly pairingCredential: string;
  readonly failure: (reason: string) => string;
  readonly unreachable: string;
}): Promise<EnvironmentId> {
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    { host: input.httpBaseUrl, pairingCode: input.pairingCredential },
    { label: "Pair with Boat machine", reportFailure: false },
  );
  if (paired._tag === "Failure") throw new Error(input.failure(failureMessage(paired)));
  await waitForConnection(paired.value, input.unreachable);
  return paired.value;
}

/**
 * Pairs this client with a machine the host already runs, such as one an agent started, and
 * resolves once it is connected. A stopped machine is resumed first.
 */
export function pairBoatMachine(input: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly sandboxId: string;
}): Promise<EnvironmentId> {
  return pairOnce(input.sandboxId, async () => {
    const minted = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.pairBoatMachine,
      { environmentId: input.hostEnvironmentId, input: { sandboxId: input.sandboxId } },
      { label: "Pair with Boat machine", reportFailure: false },
    );
    if (minted._tag === "Failure") throw new Error(failureMessage(minted));
    return pairWithCredential({
      httpBaseUrl: minted.value.httpBaseUrl,
      pairingCredential: minted.value.pairingCredential,
      failure: (reason) => `Could not pair with the Boat machine: ${reason}`,
      unreachable: "The Boat machine is running, but this client did not reach it within a minute.",
    });
  });
}

/**
 * Connects this client to the machine the host's acquire picked, with the credential it returned,
 * and resolves once it is connected. A machine this client already knows is not paired again: it
 * is reconnected, since a machine the host resumed has a connection backing off. The machine is
 * never deleted here, since an acquire may pick one that already holds other work.
 */
export function connectAcquiredBoatMachine(input: {
  readonly sandboxId: string;
  readonly httpBaseUrl: string;
  readonly pairingCredential: string;
}): Promise<EnvironmentId> {
  return pairOnce(input.sandboxId, async () => {
    const known = [...appAtomRegistry.get(environmentPresentations.presentationsAtom)].find(
      ([, presentation]) =>
        isBoatMachineAt(
          { httpBaseUrl: input.httpBaseUrl },
          connectionCatalogDisplayUrl(presentation.entry),
        ),
    );
    const unreachable =
      "The Boat machine is running, but this client did not reach it within a minute. Try again.";
    if (known) {
      const [knownEnvironmentId, presentation] = known;
      if (presentation.connection.phase !== "connected") {
        await runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, knownEnvironmentId, {
          label: "Reconnect to Boat machine",
          reportFailure: false,
        });
      }
      await waitForConnection(knownEnvironmentId, unreachable);
      return knownEnvironmentId;
    }
    return pairWithCredential({
      httpBaseUrl: input.httpBaseUrl,
      pairingCredential: input.pairingCredential,
      failure: (reason) =>
        `Could not pair with the Boat machine, which is still running: ${reason}`,
      unreachable,
    });
  });
}

const GRANT_TIMEOUT_MS = 60_000;

function waitForOperateGrantArrived(environmentId: EnvironmentId) {
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentSession.sessionStateAtom(environmentId),
    predicate: (result) => sessionHasScope(result, AuthOrchestrationOperateScope),
    timeoutMs: GRANT_TIMEOUT_MS,
  });
}

const NO_GRANT_MESSAGE =
  "The Boat machine is running, but it did not give this client access within a minute.";

async function waitForOperateGrant(environmentId: EnvironmentId): Promise<void> {
  if (!(await waitForOperateGrantArrived(environmentId))) throw new Error(NO_GRANT_MESSAGE);
}

/**
 * Resolves once this client holds the operate grant on the machine and its server lists the
 * project, which a thread started there needs. Throws what is missing when they do not arrive.
 */
export async function waitForBoatProject(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): Promise<void> {
  const [granted, listed] = await Promise.all([
    waitForOperateGrantArrived(input.environmentId),
    waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentProjects.projectsAtom,
      predicate: (projects) =>
        projects.some(
          (project) =>
            project.environmentId === input.environmentId && project.id === input.projectId,
        ),
      timeoutMs: GRANT_TIMEOUT_MS,
    }),
  ]);
  if (!granted) throw new Error(NO_GRANT_MESSAGE);
  if (!listed) {
    throw new Error(
      "The Boat machine is running, but it did not open the project within a minute.",
    );
  }
}
