/**
 * Keeps a copy of each Boat machine's usage on this server. Agents run on the machine, so their
 * usage lives on its disk and would be lost when the machine is deleted; this server reads it
 * through the machine's own T3 Code server and stores it where the usage page counts it.
 *
 * @module boat/boatUsage
 */
import {
  AuthDiagnosticsReadScope,
  EnvironmentAuthorizationError,
  UsageReadError,
  UsageSummary,
  UsageSummaryInput,
  WS_METHODS,
  type BoatMachine,
  type UsageDay,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import {
  IMPORTED_USAGE_DIRECTORY,
  ImportedUsage,
  encodeImportedUsage,
  floorToHour,
  hourlyWindows,
  importedUsageFileName,
  mergeImportedUsage,
} from "../usage/importedUsage.ts";
import type { BoatApi } from "./BoatApi.ts";
import { openMachineRpc } from "./machineRpc.ts";

const HOUR_MS = 60 * 60 * 1000;
// The usage page reads at most this far back, and older transcripts may already be gone.
const BACKFILL_MS = 92 * 24 * HOUR_MS;

const UsageRpcs = RpcGroup.make(
  Rpc.make(WS_METHODS.serverGetUsageSummary, {
    payload: UsageSummaryInput,
    success: UsageSummary,
    error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
  }),
);

const decodeImportedUsage = Schema.decodeUnknownOption(Schema.fromJsonString(ImportedUsage));

const isoAt = (timestampMs: number) => DateTime.formatIso(DateTime.makeUnsafe(timestampMs));
const dayAt = (timestampMs: number) => isoAt(timestampMs).slice(0, 10) as UsageDay;

/**
 * Reads the hours of a running machine's usage this server does not have yet and stores them.
 * Never fails: a machine that cannot answer keeps what was stored before.
 */
export const captureBoatUsage = Effect.fn("BoatUsage.capture")(
  function* (input: {
    readonly boat: BoatApi;
    readonly machine: BoatMachine;
    readonly stateDir: string;
    readonly t3Command: string;
    readonly timeout: Duration.Input;
  }) {
    const { boat, machine } = input;
    const machineUrl = machine.httpBaseUrl;
    if (machineUrl === null) return;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(
      input.stateDir,
      IMPORTED_USAGE_DIRECTORY,
      importedUsageFileName(machineUrl),
    );
    const previous = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map((text) => Option.getOrNull(decodeImportedUsage(text))),
      Effect.orElseSucceed(() => null),
    );

    const nowMs = yield* Clock.currentTimeMillis;
    const capturedUntilMs = floorToHour(nowMs);
    const sinceMs = Math.max(
      previous === null
        ? floorToHour(Date.parse(machine.createdAt) || nowMs)
        : Date.parse(previous.capturedUntil),
      floorToHour(nowMs - BACKFILL_MS),
    );
    // The current hour is still filling, so it is read again next time.
    const windows = hourlyWindows(sinceMs, capturedUntilMs + HOUR_MS);

    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* Effect.gen(function* () {
      // A short-lived token that can only read usage and diagnostics.
      const client = yield* openMachineRpc({
        boat,
        sandboxId: machine.sandboxId,
        machineUrl,
        t3Command: input.t3Command,
        group: UsageRpcs,
        scopes: [AuthDiagnosticsReadScope],
        ttl: "15m",
        label: "T3 Code usage copy",
      });
      // Each day read is saved before the next, so a long first copy keeps what it read so far.
      let kept = previous;
      for (const window of windows) {
        const summary = yield* client[WS_METHODS.serverGetUsageSummary]({
          sinceDay: dayAt(window.sinceMs),
          untilDay: dayAt(window.untilMs - 1),
          timeZone: "UTC",
          resolution: "hour",
          sinceTime: isoAt(window.sinceMs),
          untilTime: isoAt(window.untilMs),
          awaitRefresh: true,
        });
        kept = mergeImportedUsage(
          kept,
          machineUrl,
          [{ window, summary }],
          isoAt(nowMs),
          Math.min(window.untilMs, capturedUntilMs),
        );
        yield* writeFileStringAtomically({ filePath, contents: encodeImportedUsage(kept) });
      }
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal));
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeout(input.timeout),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not keep a copy of a Boat machine's usage.", {
          sandboxId: input.machine.sandboxId,
          cause,
        }),
      ),
    ),
);
