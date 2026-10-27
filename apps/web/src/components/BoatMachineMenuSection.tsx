import {
  BOAT_SIZE_DETAILS,
  type BoatMachine,
  boatMachineLabel,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";

import { ensureLocalApi } from "../localApi";
import { useEnvironments } from "../state/environments";
import {
  BoatMachineMenuItems,
  boatMachineStateText,
  useBoatMachineActions,
} from "./settings/BoatSettings";
import { MenuGroup, MenuGroupLabel, MenuItem } from "./ui/menu";

// Boat has no page per machine; its dashboard lists them all.
const BOAT_DASHBOARD_URL = "https://boat.dev/dashboard";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A Boat machine's details and actions, for the menu of the environment that runs on it. */
export function BoatMachineMenuSection({
  hostEnvironmentId,
  machine,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly machine: BoatMachine;
}) {
  const { environments } = useEnvironments();
  const { act, busySandboxId } = useBoatMachineActions(hostEnvironmentId, environments);
  const { report } = machine;
  return (
    <MenuGroup>
      <MenuGroupLabel>{boatMachineLabel(machine)}</MenuGroupLabel>
      <div className="space-y-0.5 px-2 pb-1.5 text-xs text-foreground">
        <p className={machine.state === "failed" ? "text-destructive" : undefined}>
          {boatMachineStateText(machine)}
        </p>
        <p>{BOAT_SIZE_DETAILS[machine.size].specs}</p>
        {report ? (
          <p>
            {plural(report.threads, "thread")}, {plural(report.activeTurns, "running turn")}
          </p>
        ) : null}
        {machine.notice ? <p className="max-w-64">{machine.notice}</p> : null}
      </div>
      <BoatMachineMenuItems
        machine={machine}
        busy={busySandboxId === machine.sandboxId}
        onAction={(action) => void act(machine, action)}
      />
      <MenuItem onClick={() => void ensureLocalApi().shell.openExternal(BOAT_DASHBOARD_URL)}>
        <ExternalLinkIcon className="size-3" aria-hidden="true" />
        Open Boat dashboard
      </MenuItem>
    </MenuGroup>
  );
}
