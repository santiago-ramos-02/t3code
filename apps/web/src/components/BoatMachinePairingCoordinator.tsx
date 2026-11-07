import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { isBoatMachineAt, useBoat } from "../hooks/useBoat";
import { pairBoatMachine } from "../lib/boatMachine";
import { useEnvironments } from "../state/environments";
import { useEnvironmentScope } from "../state/session";

/**
 * Pairs this client with each running Boat machine it is not paired with, such as one an agent
 * started, so the machine's threads show up here. A machine that fails to pair is tried again
 * only from its menu in Settings, so a broken one is not retried in a loop.
 */
export function BoatMachinePairingCoordinator() {
  const { hostEnvironmentId, status } = useBoat();
  const { environments } = useEnvironments();
  const canPair = useEnvironmentScope(hostEnvironmentId, AuthOrchestrationOperateScope);
  const tried = useRef(new Set<string>());
  const machines = status?.machines;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs this client with Boat machines the host runs, which live outside React
  useEffect(() => {
    if (hostEnvironmentId === null || !canPair) return;
    for (const machine of machines ?? []) {
      if (machine.state !== "running" || machine.httpBaseUrl === null) continue;
      if (tried.current.has(machine.sandboxId)) continue;
      const paired = environments.some((environment) =>
        isBoatMachineAt(machine, environment.displayUrl),
      );
      if (paired) continue;
      tried.current.add(machine.sandboxId);
      void pairBoatMachine({ hostEnvironmentId, sandboxId: machine.sandboxId }).catch(
        (cause: unknown) => console.warn("Could not pair with a Boat machine.", cause),
      );
    }
  }, [canPair, environments, hostEnvironmentId, machines]);
  return null;
}
