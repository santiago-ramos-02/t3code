import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type BoatMachine,
  type BoatStatus,
  type EnvironmentId,
} from "@t3tools/contracts";

import { useEffect, useRef, useState } from "react";

import { wakeBoatMachine } from "../lib/boatMachine";
import {
  type EnvironmentPresentation,
  useEnvironment,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useStableCallback } from "./useStableCallback";

/**
 * Boat lives on the primary environment's server, which holds the API key and starts machines.
 * Status is null until that server answers, or when there is no primary environment.
 */
export function useBoat(): {
  readonly hostEnvironmentId: EnvironmentId | null;
  readonly status: BoatStatus | null;
} {
  const hostEnvironmentId = usePrimaryEnvironmentId();
  const status = useEnvironmentQuery(
    hostEnvironmentId
      ? serverEnvironment.boatStatus({ environmentId: hostEnvironmentId, input: {} })
      : null,
  ).data;
  return { hostEnvironmentId, status: status ?? null };
}

/** The environment that starts Boat machines for this project, or null when it cannot. */
export function useBoatHostFor(project: EnvironmentProject | null): EnvironmentId | null {
  const { hostEnvironmentId, status } = useBoat();
  const canStart = useEnvironmentScope(hostEnvironmentId, AuthOrchestrationOperateScope);
  // A machine starts empty, so the project has to be clonable.
  if (!project?.repositoryIdentity?.locator.remoteUrl) return null;
  return status?.configured === true && canStart ? hostEnvironmentId : null;
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

/** The host's Boat machine an environment runs on, or null when it is not one. */
function useBoatMachineFor(environment: EnvironmentPresentation | null): {
  readonly hostEnvironmentId: EnvironmentId | null;
  readonly machine: BoatMachine | null;
} {
  const { hostEnvironmentId, status } = useBoat();
  const machine =
    environment === null || environment.environmentId === hostEnvironmentId
      ? null
      : boatMachineAt(status, environment.displayUrl);
  return { hostEnvironmentId, machine };
}

/** The host's Boat machine an environment id runs on, or null when it is not one. */
export function useBoatMachineOf(environmentId: EnvironmentId) {
  const { hostEnvironmentId, machine } = useBoatMachineFor(useEnvironment(environmentId));
  return hostEnvironmentId !== null && machine !== null ? { hostEnvironmentId, machine } : null;
}

export type BoatMachineWake = {
  readonly machine: BoatMachine;
  readonly waking: boolean;
  readonly error: string | null;
  /** Resumes the machine; resolves true once this client is connected to it. */
  readonly wake: () => Promise<boolean>;
};

/**
 * Opening a thread on a stopped Boat machine resumes it. A machine that stops while its thread
 * stays open is left stopped until the user resumes it or sends a message, so an open tab does
 * not undo the idle stop.
 */
export function useBoatMachineWake(
  environment: EnvironmentPresentation | null,
  threadKey: string | null,
): BoatMachineWake | null {
  const { hostEnvironmentId, machine } = useBoatMachineFor(environment);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wake = useStableCallback(async () => {
    if (!machine || !hostEnvironmentId || !environment) return false;
    setWaking(true);
    setError(null);
    try {
      await wakeBoatMachine({
        hostEnvironmentId,
        environmentId: environment.environmentId,
        sandboxId: machine.sandboxId,
      });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Boat machine did not resume.");
      return false;
    } finally {
      setWaking(false);
    }
  });
  const openedThreadKey = useRef<string | null>(null);
  useEffect(() => {
    if (threadKey === null || machine === null || openedThreadKey.current === threadKey) return;
    openedThreadKey.current = threadKey;
    if (machine.state === "stopped") void wake();
  }, [machine, threadKey, wake]);
  // The host lists the machine as stopped until its resume finishes.
  return machine?.state === "stopped" ? { machine, waking, error, wake } : null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
