/**
 * RPC connection from this server to a Boat machine's T3 Code server, with a short-lived access
 * token the machine issues for itself. The token stays in memory: never in a command, log, or error.
 *
 * @module boat/machineRpc
 */
import {
  AuthWebSocketTicketResult,
  BoatError,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";

import type { BoatApi } from "./BoatApi.ts";

// The machine prints the token; the line may follow shell noise from a login profile.
const issueAccessToken = (input: {
  readonly t3Command: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly ttl: string;
  readonly label: string;
}) =>
  `sh -lc '${input.t3Command} auth session issue ${input.scopes.map((scope) => `--scope ${scope}`).join(" ")} --ttl ${input.ttl} --label "${input.label}" --token-only'`;

/**
 * Opens an RPC client to the running T3 Code server of a machine, good for as long as the
 * surrounding scope lives, so a stream can stay open for a whole turn. The token only carries
 * `scopes` and expires after `ttl`, which only has to outlast the connecting; the socket does not
 * depend on it afterwards. Fails with a BoatError that names the step and never the credentials.
 */
export const openMachineRpc = Effect.fn("MachineRpc.open")(function* <Rpcs extends Rpc.Any>(input: {
  readonly boat: BoatApi;
  readonly sandboxId: string;
  /** The machine's public HTTPS address. */
  readonly machineUrl: string;
  readonly t3Command: string;
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly ttl: string;
  /** Names the session on the machine, in its list of sessions. */
  readonly label: string;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const issued = yield* input.boat.runCommand(input.sandboxId, {
    command: issueAccessToken(input),
    timeoutSeconds: 120,
  });
  const accessToken = issued.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (issued.exitCode !== 0 || accessToken.length === 0) {
    return yield* new BoatError({ detail: "The machine did not issue an access token." });
  }
  const ticket = yield* httpClient
    .execute(
      HttpClientRequest.post(`${input.machineUrl}/api/auth/websocket-ticket`).pipe(
        HttpClientRequest.bearerToken(accessToken),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult)),
      Effect.map((result) => result.ticket),
      // The cause can carry the request, so only the step is reported.
      Effect.mapError(
        () => new BoatError({ detail: "The Boat machine did not accept the access token." }),
      ),
    );

  const socket = Socket.layerWebSocket(
    `${input.machineUrl.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(Redacted.value(ticket))}&${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
    { openTimeout: "15 seconds" },
  );
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }),
  ).pipe(Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)));
  // The protocol's reader must live in a built context, as in the client runtime.
  const context = yield* Layer.build(protocol);
  return yield* RpcClient.make(input.group).pipe(Effect.provide(context));
});
