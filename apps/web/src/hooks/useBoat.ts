import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type BoatMachine,
  type BoatStatus,
  type EnvironmentId,
} from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";

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
export function isBoatMachineAt(machine: BoatMachine, httpBaseUrl: string | null): boolean {
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
