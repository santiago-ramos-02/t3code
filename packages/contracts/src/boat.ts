import * as Schema from "effect/Schema";

/**
 * Boat (boat.dev) machines: the environment holds a Boat API key and starts one short-lived
 * Boat sandbox per thread, each running its own T3 Code server. Boat bills per second while a
 * sandbox runs, so a stopped or deleted one costs nothing.
 */

// Boat's sandbox types; `xlarge` needs a $100 Boat plan or higher.
export const BoatSize = Schema.Literals(["small", "default", "large", "xlarge"]);
export type BoatSize = typeof BoatSize.Type;

export const BoatSettings = Schema.Struct({
  // The named snapshot new machines start from, with providers and logins already set up. With
  // none, machines start from Boat's base image and run the published T3 Code server.
  template: Schema.NullOr(Schema.String),
  defaultSize: BoatSize,
  // A machine with no running turn for this long is stopped; opening its thread resumes it.
  idleStopMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
});
export type BoatSettings = typeof BoatSettings.Type;

export const DEFAULT_BOAT_SETTINGS: BoatSettings = {
  template: null,
  defaultSize: "default",
  idleStopMinutes: 5,
};

export const BoatMachineState = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "stopped",
  "deleting",
  "failed",
]);
export type BoatMachineState = typeof BoatMachineState.Type;

export const BoatMachine = Schema.Struct({
  sandboxId: Schema.String,
  size: BoatSize,
  state: BoatMachineState,
  // The machine's T3 Code server, once it answers.
  httpBaseUrl: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  // Why the machine failed to start or change state, for the user.
  problem: Schema.NullOr(Schema.String),
});
export type BoatMachine = typeof BoatMachine.Type;

/** The name a machine's T3 Code server reports, so clients tell machines apart. */
export const boatMachineLabel = (machine: Pick<BoatMachine, "sandboxId" | "size">) =>
  `Boat · ${machine.size} · ${machine.sandboxId.replace(/[^a-z0-9]/gi, "").slice(-4)}`;

export const BoatStatus = Schema.Struct({
  // Whether the environment holds a Boat API key.
  configured: Schema.Boolean,
  settings: BoatSettings,
  machines: Schema.Array(BoatMachine),
});
export type BoatStatus = typeof BoatStatus.Type;

export const BoatConfigureInput = Schema.Struct({
  // A new key replaces the saved one; null removes it.
  apiKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  settings: Schema.optionalKey(BoatSettings),
});
export type BoatConfigureInput = typeof BoatConfigureInput.Type;

export const BoatSpawnInput = Schema.Struct({
  size: Schema.optionalKey(BoatSize),
});
export type BoatSpawnInput = typeof BoatSpawnInput.Type;

export const BoatSpawnResult = Schema.Struct({
  machine: BoatMachine,
  httpBaseUrl: Schema.String,
  // A one-time pairing credential for the machine's T3 Code server.
  pairingCredential: Schema.String,
});
export type BoatSpawnResult = typeof BoatSpawnResult.Type;

export const BoatMachineAction = Schema.Literals(["stop", "resume", "delete"]);
export type BoatMachineAction = typeof BoatMachineAction.Type;

export const BoatMachineActionInput = Schema.Struct({
  sandboxId: Schema.String,
  action: BoatMachineAction,
});
export type BoatMachineActionInput = typeof BoatMachineActionInput.Type;

export class BoatError extends Schema.TaggedError<BoatError>()("BoatError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
