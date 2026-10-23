import {
  boatMachineLabel,
  OrchestratorMcpFailure,
  type BoatError,
  type BoatMachine,
  type BoatStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as BoatMachines from "../../../boat/BoatMachines.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { buildPairingUrl } from "../../../startupAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BoatToolkit } from "./tools.ts";

const labeled = (machine: BoatMachine) => ({ ...machine, label: boatMachineLabel(machine) });
const machineList = (status: BoatStatus) => ({
  configured: status.configured,
  defaultSize: status.settings.defaultSize,
  machines: status.machines.map(labeled),
});
const boatFailure = (error: BoatError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.detail });

export const layer = McpToolAccess.toLayer(BoatToolkit, {
  t3_boat_machine_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const boat = yield* BoatMachines.BoatMachines;
      return machineList(yield* boat.current);
    }),
  ),
  t3_boat_machine_start: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const boat = yield* BoatMachines.BoatMachines;
      // The calling thread's project, whose worktree cleanup rules then apply to the machine.
      const { thread } = yield* McpInvocationContext.McpInvocationContext;
      const shell =
        thread === undefined
          ? null
          : yield* ThreadManagement.ThreadManagementService.use((threads) =>
              threads.getThreadShell(thread.threadId),
            ).pipe(Effect.orElseSucceed(() => null));
      const started = yield* boat
        .spawn(shell ? { ...input, projectId: shell.projectId } : input)
        .pipe(Effect.mapError(boatFailure));
      return {
        machine: labeled(started.machine),
        pairingUrl: buildPairingUrl(started.httpBaseUrl, started.pairingCredential),
      };
    }),
  ),
  t3_boat_machine_action: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const boat = yield* BoatMachines.BoatMachines;
      return machineList(yield* boat.machineAction(input).pipe(Effect.mapError(boatFailure)));
    }),
  ),
});
