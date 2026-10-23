import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { isBoatMachineAt, useBoat } from "../hooks/useBoat";
import { useEnvironments } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";

/**
 * Forgets this client's pairing with each Boat machine the host deleted, such as by worktree
 * cleanup or from another device, and says why.
 */
export function BoatDeletedMachineCoordinator() {
  const { status } = useBoat();
  const { environments } = useEnvironments();
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const removing = useRef(new Set<EnvironmentId>());
  const deleted = status?.deleted;
  useEffect(() => {
    for (const machine of deleted ?? []) {
      const paired = environments.find(
        (environment) =>
          environment.entry.target._tag !== "PrimaryConnectionTarget" &&
          isBoatMachineAt(machine, environment.displayUrl),
      );
      if (!paired || removing.current.has(paired.environmentId)) continue;
      removing.current.add(paired.environmentId);
      void removeEnvironment(paired.environmentId).then((result) => {
        removing.current.delete(paired.environmentId);
        if (result._tag === "Success") {
          toastManager.add({
            type: "info",
            title: `Deleted ${machine.label}`,
            description: machine.reason,
          });
        }
      });
    }
  }, [deleted, environments, removeEnvironment]);
  return null;
}
