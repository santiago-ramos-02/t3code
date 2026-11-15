import { useAtomValue } from "@effect/atom-react";
import {
  boatMachineAt,
  isBoatMachineAt,
  type BoatDraftStartProgress,
  type BoatDraftStartStep,
} from "@t3tools/client-runtime/boat";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type BoatStatus,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import { connectPairingCode } from "../../connection/onboarding";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { environmentSession, sessionHasScope } from "../../state/session";
import { workspaceConnections } from "../../state/workspace";
import { boatMachineSleep, type BoatSleep } from "./boat-draft";

/**
 * Boat machines are ordinary environments. The connected environment that holds the Boat key (the
 * host) picks a machine and opens the project there, and this app pairs with it like any other.
 */

// A machine that was started or resumed and still has not connected by then is broken.
const CONNECT_TIMEOUT_MS = 60_000;

export interface BoatHost {
  readonly environmentId: EnvironmentId;
  readonly status: BoatStatus;
}

/** The first connected environment that has Boat set up and lets this device start work on it. */
export const boatHostAtom = Atom.make((get): BoatHost | null => {
  for (const environment of get(workspaceConnections.environmentsAtom)) {
    if (environment.connectionState !== "connected") continue;
    const { environmentId } = environment;
    const canOperate = sessionHasScope(
      get(environmentSession.sessionStateAtom(environmentId)),
      AuthOrchestrationOperateScope,
    );
    if (!canOperate) continue;
    const status = AsyncResult.getOrElse(
      get(serverEnvironment.boatStatus({ environmentId, input: {} })),
      () => null,
    );
    if (status?.configured) return { environmentId, status };
  }
  return null;
}).pipe(Atom.withLabel("mobile-boat:host"));

export function useBoatHost(): BoatHost | null {
  return useAtomValue(boatHostAtom);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function failureMessage(
  result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
): string {
  return isAtomCommandInterrupted(result)
    ? "The request was interrupted."
    : errorMessage(squashAtomCommandFailure(result));
}

/** Resolves once `ready` holds for the atom's value, or rejects with `timeoutMessage`. */
function waitUntil<A>(
  atom: Atom.Atom<A>,
  ready: (value: A) => boolean,
  timeoutMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
    };
    const timeout = setTimeout(() => {
      settle();
      reject(new Error(timeoutMessage));
    }, CONNECT_TIMEOUT_MS);
    const check = (value: A) => {
      if (settled || !ready(value)) return;
      settle();
      resolve();
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    check(appAtomRegistry.get(atom));
  });
}

function waitForConnection(environmentId: EnvironmentId): Promise<void> {
  return waitUntil(
    environmentPresentations.presentationAtom(environmentId),
    (presentation) => presentation?.connection.phase === "connected" && !!presentation.serverConfig,
    "The Boat machine started but did not connect within a minute.",
  );
}

function waitForOperateScope(environmentId: EnvironmentId): Promise<void> {
  return waitUntil(
    environmentSession.sessionStateAtom(environmentId),
    (session) => sessionHasScope(session, AuthOrchestrationOperateScope),
    "The Boat machine did not let this device start threads.",
  );
}

async function waitForProject(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<EnvironmentProject> {
  const missing = "The Boat machine did not open the project.";
  const find = (projects: ReadonlyArray<EnvironmentProject>) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId);
  await waitUntil(
    environmentProjects.projectsAtom,
    (projects) => find(projects) !== undefined,
    missing,
  );
  const project = find(appAtomRegistry.get(environmentProjects.projectsAtom));
  if (project === undefined) throw new Error(missing);
  return project;
}

/** Reports the steps the host lists for the machine whose start carried `startId`. */
function watchMachineSteps(
  hostEnvironmentId: EnvironmentId,
  startId: string,
  onSteps: (steps: BoatDraftStartProgress["machineSteps"]) => void,
): () => void {
  const atom = serverEnvironment.boatStatus({ environmentId: hostEnvironmentId, input: {} });
  return appAtomRegistry.subscribe(atom, (result) => {
    const machine = AsyncResult.getOrElse(result, () => null)?.machines.find(
      (candidate) => candidate.startId === startId,
    );
    if (machine) onSteps(machine.startSteps);
  });
}

/** Pairs this app with the machine unless it is already connected; resolves to its environment. */
async function connectToMachine(httpBaseUrl: string, pairingCode: string): Promise<EnvironmentId> {
  const known = appAtomRegistry
    .get(workspaceConnections.environmentsAtom)
    .find((environment) => isBoatMachineAt({ httpBaseUrl }, environment.displayUrl));
  if (known?.connectionState === "connected") return known.environmentId;
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairingCode,
    { host: httpBaseUrl, pairingCode },
    { label: connectPairingCode.label, reportFailure: false, reportDefect: true },
  );
  if (paired._tag === "Failure") {
    throw new Error(`Could not pair with the Boat machine: ${failureMessage(paired)}`);
  }
  return paired.value;
}

export type BoatDraftStartResult =
  | { readonly _tag: "ready"; readonly project: EnvironmentProject }
  | { readonly _tag: "failed"; readonly message: string };

/**
 * Has the host pick a machine and open the repository there, pairs with it, and resolves to the
 * machine's project once this device may start threads on it. Reports every step on the way; the
 * caller marks the last one, starting the thread, done.
 */
export async function startOnBoat(input: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly onProgress: (progress: BoatDraftStartProgress) => void;
}): Promise<BoatDraftStartResult> {
  let progress: BoatDraftStartProgress = {
    step: "machine",
    failed: false,
    machineSteps: [],
    repository: input.remoteUrl,
  };
  const report = (patch: Partial<BoatDraftStartProgress>) => {
    progress = { ...progress, ...patch };
    input.onProgress(progress);
  };
  const advance = (step: BoatDraftStartStep) => report({ step });
  report({});
  const startId = uuidv4();
  const stopWatching = watchMachineSteps(input.hostEnvironmentId, startId, (machineSteps) =>
    report({ machineSteps }),
  );
  try {
    const acquired = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.acquireBoatMachine,
      {
        environmentId: input.hostEnvironmentId,
        input: { remoteUrl: input.remoteUrl, branch: input.branch, startId },
      },
      {
        label: serverEnvironment.acquireBoatMachine.label,
        reportFailure: false,
        reportDefect: true,
      },
    ).finally(stopWatching);
    if (acquired._tag === "Failure") throw new Error(failureMessage(acquired));
    const { httpBaseUrl, pairingCredential, projectId } = acquired.value;
    advance("connect");
    const environmentId = await connectToMachine(httpBaseUrl, pairingCredential);
    await waitForConnection(environmentId);
    await waitForOperateScope(environmentId);
    advance("project");
    const project = await waitForProject(environmentId, projectId);
    advance("thread");
    return { _tag: "ready", project };
  } catch (error) {
    report({ failed: true });
    return { _tag: "failed", message: errorMessage(error) };
  }
}

const wakes = new Map<string, Promise<void>>();

// Only this app's own wake reads as waking; connection retries cycle the phase on their own.
const wakingAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

/** Resumes a stopped Boat machine from the host and resolves once this app is connected again. */
export function wakeBoatMachine(input: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
  readonly sandboxId: string;
}): Promise<void> {
  const pending = wakes.get(input.sandboxId);
  if (pending) return pending;
  const waking = wakingAtom(input.environmentId);
  appAtomRegistry.set(waking, true);
  const wake = (async () => {
    const resumed = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.runBoatMachineAction,
      {
        environmentId: input.hostEnvironmentId,
        input: { sandboxId: input.sandboxId, action: "resume" },
      },
      {
        label: serverEnvironment.runBoatMachineAction.label,
        reportFailure: false,
        reportDefect: true,
      },
    );
    if (resumed._tag === "Failure") throw new Error(failureMessage(resumed));
    // The connection backs off while the machine is stopped; it reconnects now instead.
    await runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, input.environmentId, {
      label: environmentCatalog.retryNow.label,
      reportFailure: false,
      reportDefect: true,
    });
    await waitForConnection(input.environmentId);
  })()
    .catch((error: unknown) => Dialog.alert("Could not wake the Boat machine", errorMessage(error)))
    .finally(() => {
      wakes.delete(input.sandboxId);
      appAtomRegistry.set(waking, false);
    });
  wakes.set(input.sandboxId, wake);
  return wake;
}

const NO_MACHINE_ATOM = Atom.make<null>(null).pipe(Atom.withLabel("mobile-boat:no-machine"));
const NOT_WAKING_ATOM = Atom.make(false).pipe(Atom.withLabel("mobile-boat:not-waking"));

/** The host's Boat machine an environment runs on, matched by address; null for any other. */
const environmentMachineAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const host = get(boatHostAtom);
    if (host === null || host.environmentId === environmentId) return null;
    const environment = get(workspaceConnections.environmentsAtom).find(
      (candidate) => candidate.environmentId === environmentId,
    );
    const machine = boatMachineAt(host.status, environment?.displayUrl ?? null);
    return machine === null ? null : { hostEnvironmentId: host.environmentId, machine };
  }).pipe(Atom.withLabel(`mobile-boat:environment-machine:${environmentId}`)),
);

export interface BoatMachineSleep {
  readonly state: BoatSleep;
  /** Resumes the machine; the thread's next message waits in the outbox until it connects. */
  readonly wake: () => void;
}

/**
 * A Boat machine the host stopped when its threads went quiet is asleep, not disconnected: the
 * next message wakes it. Null for any other environment.
 */
export function useBoatMachineSleep(
  environmentId: EnvironmentId | null,
  phase: EnvironmentConnectionPhase | null,
): BoatMachineSleep | null {
  const target = useAtomValue(
    environmentId === null ? NO_MACHINE_ATOM : environmentMachineAtom(environmentId),
  );
  const waking = useAtomValue(environmentId === null ? NOT_WAKING_ATOM : wakingAtom(environmentId));
  const state = boatMachineSleep({ machine: target?.machine ?? null, waking, phase });
  if (state === null || environmentId === null || target === null) return null;
  return {
    state,
    wake: () =>
      void wakeBoatMachine({
        hostEnvironmentId: target.hostEnvironmentId,
        environmentId,
        sandboxId: target.machine.sandboxId,
      }),
  };
}
