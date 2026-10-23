import {
  BoatMachine,
  BoatMachineActionInput,
  BoatSize,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as BoatMachines from "../../../boat/BoatMachines.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BoatMachines.BoatMachines,
  ],
};
const LabeledMachine = Schema.Struct({ ...BoatMachine.fields, label: Schema.String });
const MachineList = Schema.Struct({
  configured: Schema.Boolean,
  defaultSize: BoatSize,
  machines: Schema.Array(LabeledMachine),
});

const BoatMachineListTool = Tool.make("t3_boat_machine_list", {
  ...shared,
  description:
    "List the Boat machines this server started, with their state and size. Boat bills per second while a machine runs; stopped and deleted machines cost nothing. configured is false until a Boat key is added in Settings > Connections.",
  success: MachineList,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const BoatMachineStartTool = Tool.make("t3_boat_machine_start", {
  ...shared,
  description:
    "Start a new Boat machine running its own T3 Code server, billed per second to the user's Boat account. Omit size for the user's default; only use a larger size when the user asks. Takes a minute or two. Give the user pairingUrl: opening it in T3 Code, on any device, adds the machine as an environment. The link works once. Stop or delete the machine with t3_boat_machine_action when the user is done.",
  parameters: Schema.Struct({ size: Schema.optionalKey(BoatSize) }),
  success: Schema.Struct({ machine: LabeledMachine, pairingUrl: Schema.String }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const BoatMachineActionTool = Tool.make("t3_boat_machine_action", {
  ...shared,
  description:
    "Stop, resume, or delete a Boat machine from t3_boat_machine_list. A stopped machine keeps its files and can be resumed; delete removes it and its files for good.",
  parameters: BoatMachineActionInput,
  success: MachineList,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const BoatToolkit = Toolkit.make(
  BoatMachineListTool,
  BoatMachineStartTool,
  BoatMachineActionTool,
);
