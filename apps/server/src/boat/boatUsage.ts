/**
 * Keeps a copy of each Boat machine's usage on this server. Agents run on the machine, so their
 * usage lives on its disk and would be lost when the machine is deleted; this server reads it
 * through the machine's own T3 Code server and stores it where the usage page counts it.
 *
 * @module boat/boatUsage
 */
import {
  AuthWebSocketTicketResult,
  BoatError,
  EnvironmentAuthorizationError,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
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
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
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

// A short-lived token that can only read usage and diagnostics, issued by the machine's own CLI.
const issueUsageToken = (t3Command: string) =>
  `sh -lc '${t3Command} auth session issue --scope diagnostics:read --ttl 15m --label "T3 Code usage copy" --token-only'`;

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
    const httpClient = yield* HttpClient.HttpClient;
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

    const token = yield* boat
      .runCommand(machine.sandboxId, {
        command: issueUsageToken(input.t3Command),
        timeoutSeconds: 120,
      })
      .pipe(
        Effect.flatMap((result) => {
          const issued = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
          return result.exitCode === 0 && issued.length > 0
            ? Effect.succeed(issued)
            : Effect.fail(new BoatError({ detail: "The machine did not issue a usage token." }));
        }),
      );
    const ticket = yield* httpClient
      .execute(
        HttpClientRequest.post(`${machineUrl}/api/auth/websocket-ticket`).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult)),
        Effect.map((result) => result.ticket),
      );

    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* Effect.gen(function* () {
      const socket = Socket.layerWebSocket(
        `${machineUrl.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}&${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
        { openTimeout: "15 seconds" },
      ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
      const protocol = Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)));
      // The protocol's reader must live in a built context, as in the client runtime.
      const context = yield* Layer.build(protocol);
      const client = yield* RpcClient.make(UsageRpcs).pipe(Effect.provide(context));
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
    }).pipe(Effect.scoped);
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
