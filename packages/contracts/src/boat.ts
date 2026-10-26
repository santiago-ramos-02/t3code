import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * Boat (boat.dev) machines: the environment holds a Boat API key and starts one short-lived
 * Boat sandbox per thread, each running its own T3 Code server. Boat bills per second while a
 * sandbox runs, so a stopped or deleted one costs nothing.
 */

// Boat's sandbox types; `xlarge` needs a $100 Boat plan or higher.
export const BoatSize = Schema.Literals(["small", "default", "large", "xlarge"]);
export type BoatSize = typeof BoatSize.Type;

// Boat's published sizes and per-hour prices.
export const BOAT_SIZE_DETAILS: Readonly<
  Record<BoatSize, { readonly specs: string; readonly hourlyPrice: string; readonly note?: string }>
> = {
  small: { specs: "2 vCPU · 4 GB", hourlyPrice: "$0.018/h" },
  default: { specs: "4 vCPU · 8 GB", hourlyPrice: "$0.036/h" },
  large: { specs: "8 vCPU · 16 GB", hourlyPrice: "$0.072/h" },
  xlarge: { specs: "16 vCPU · 32 GB", hourlyPrice: "$0.20/h", note: "Needs Boat's $100 plan" },
};

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

// The steps a new machine goes through before a client can pair with it. Steps that do not apply
// to a start, such as installing when the machine already runs this server's build, are skipped.
export const BoatStartStep = Schema.Literals(["starting", "installing", "signing-in"]);
export type BoatStartStep = typeof BoatStartStep.Type;

// Absent from machines saved before the field existed.
const nullByDefault = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));

// The machine's checkouts, read before T3 Code stops it; a stopped disk does not change.
export const BoatMachineCheckouts = Schema.Struct({
  // Every checkout's HEAD is already on its remote's default branch.
  integrated: Schema.Boolean,
  unpushed: Schema.Boolean,
  trackedChanges: Schema.Boolean,
  untrackedFiles: Schema.Boolean,
  ignoredFiles: Schema.Boolean,
});
export type BoatMachineCheckouts = typeof BoatMachineCheckouts.Type;

// What the machine's own T3 Code server last reported, which the worktree cleanup rules read.
export const BoatMachineReport = Schema.Struct({
  activeTurns: Schema.Number,
  threads: Schema.Number,
  deletedThreads: Schema.Number,
  lastActivityAt: Schema.NullOr(Schema.String),
  // When its last thread settled, or null while any thread is unsettled.
  settledAt: Schema.NullOr(Schema.String),
  // Every thread has a merged pull request.
  merged: Schema.Boolean,
  // Null when the checkouts may have changed since they were read.
  checkouts: Schema.NullOr(BoatMachineCheckouts),
});
export type BoatMachineReport = typeof BoatMachineReport.Type;

export const BoatMachine = Schema.Struct({
  sandboxId: Schema.String,
  size: BoatSize,
  state: BoatMachineState,
  // The machine's T3 Code server, once it answers.
  httpBaseUrl: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  // Why the machine failed to start or change state, for the user.
  problem: Schema.NullOr(Schema.String),
  // The project it was started for, whose worktree cleanup rules apply to it.
  projectId: nullByDefault(ProjectId),
  stoppedAt: nullByDefault(Schema.String),
  report: nullByDefault(BoatMachineReport),
  // The named snapshot keeping its disk once Boat's 14 free days for a stopped disk run out.
  snapshot: nullByDefault(Schema.String),
  // Something the user should know that is not a failure, such as why cleanup kept it.
  notice: nullByDefault(Schema.String),
  // The start steps taken so far, the last being the current one; empty once the start is over.
  startSteps: Schema.Array(BoatStartStep).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type BoatMachine = typeof BoatMachine.Type;

/** The name a machine's T3 Code server reports, so clients tell machines apart. */
export const boatMachineLabel = (machine: Pick<BoatMachine, "sandboxId" | "size">) =>
  `Boat · ${machine.size} · ${machine.sandboxId.replace(/[^a-z0-9]/gi, "").slice(-4)}`;

// The Boat CLI on the environment's machine, which can sign T3 Code in without a pasted key.
export const BoatCliLogin = Schema.Struct({
  signedIn: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
});
export type BoatCliLogin = typeof BoatCliLogin.Type;

// A machine T3 Code deleted, so clients forget their pairing with it.
export const BoatDeletedMachine = Schema.Struct({
  sandboxId: Schema.String,
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  reason: Schema.String,
  deletedAt: Schema.String,
});
export type BoatDeletedMachine = typeof BoatDeletedMachine.Type;

export const BoatStatus = Schema.Struct({
  // Whether the environment holds a Boat API key.
  configured: Schema.Boolean,
  // Null when the CLI is not installed there, or not yet checked.
  cli: Schema.NullOr(BoatCliLogin),
  settings: BoatSettings,
  machines: Schema.Array(BoatMachine),
  // The most recent deletions, newest first.
  deleted: Schema.Array(BoatDeletedMachine).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type BoatStatus = typeof BoatStatus.Type;

export const BoatConfigureInput = Schema.Struct({
  // A new key replaces the saved one; null removes it.
  apiKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // Has the signed-in Boat CLI create a key for T3 Code, replacing the saved one.
  useCliLogin: Schema.optionalKey(Schema.Boolean),
  settings: Schema.optionalKey(BoatSettings),
});
export type BoatConfigureInput = typeof BoatConfigureInput.Type;

export const BoatSpawnInput = Schema.Struct({
  size: Schema.optionalKey(BoatSize),
  projectId: Schema.optionalKey(ProjectId),
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
