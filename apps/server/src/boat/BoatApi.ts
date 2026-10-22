import { BoatError, type BoatSize } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const BOAT_API_URL = "https://boat.dev/api/v1";

// Only the fields T3 Code reads; Boat's responses carry many more.
const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
});
export type BoatSandbox = typeof Sandbox.Type;

const SandboxResponse = Schema.Struct({ sandbox: Sandbox });

const CommandResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.optional(Schema.Boolean),
});
export type BoatCommandResult = typeof CommandResult.Type;

const HostedPort = Schema.Struct({ url: Schema.String });

const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/** Sandbox states in which commands run. */
export const BOAT_READY_STATES: ReadonlySet<string> = new Set(["ready", "idle", "running"]);
/** Sandbox states that end a start: it will not become ready on its own. */
export const BOAT_FAILED_STATES: ReadonlySet<string> = new Set(["error", "failed", "archived"]);

const decoder =
  <A>(operation: string, decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  (body: unknown) =>
    decode(body).pipe(
      Effect.mapError(
        () => new BoatError({ detail: `Boat answered unexpectedly when asked to ${operation}.` }),
      ),
    );

const decodeSandboxResponse = Schema.decodeUnknownEffect(SandboxResponse);
const decodeSandbox = Schema.decodeUnknownEffect(Sandbox);
const decodeCommandResult = Schema.decodeUnknownEffect(CommandResult);
const decodeHostedPort = Schema.decodeUnknownEffect(HostedPort);

/** A Boat REST client for one API key. */
export const makeBoatApi = (httpClient: HttpClient.HttpClient, apiKey: string) => {
  // Boat's JSON answer, or its error message as a BoatError.
  const send = Effect.fn("BoatApi.send")(function* (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* httpClient
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(BOAT_API_URL),
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) => new BoatError({ detail: `Boat could not ${operation}: ${cause.message}` }),
        ),
      );
    // A delete or stop may answer with no body.
    const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
    if (response.status >= 200 && response.status < 300) return body;
    const detail = Option.getOrUndefined(decodeErrorBody(body))?.message;
    return yield* new BoatError({
      detail: `Boat could not ${operation} (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    });
  });

  const sandboxPath = (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}`;

  return {
    createSandbox: (input: {
      readonly type: BoatSize;
      readonly from: string | null;
      readonly ttlSeconds: number;
    }) =>
      send(
        "create a machine",
        HttpClientRequest.post("/sandboxes").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            type: input.type,
            ttlSeconds: input.ttlSeconds,
            ...(input.from === null ? {} : { from: input.from }),
          }),
        ),
      ).pipe(
        Effect.flatMap(decoder("create a machine", decodeSandboxResponse)),
        Effect.map((response) => response.sandbox),
      ),

    getSandbox: (sandboxId: string) =>
      send("read a machine", HttpClientRequest.get(sandboxPath(sandboxId))).pipe(
        Effect.flatMap(decoder("read a machine", decodeSandbox)),
      ),

    stopSandbox: (sandboxId: string) =>
      send(
        "stop a machine",
        HttpClientRequest.post(`${sandboxPath(sandboxId)}/stop`).pipe(
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      ).pipe(Effect.asVoid),

    resumeSandbox: (sandboxId: string, ttlSeconds: number) =>
      send(
        "resume a machine",
        HttpClientRequest.post(`${sandboxPath(sandboxId)}/resume`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ ttlSeconds }),
        ),
      ).pipe(Effect.asVoid),

    // Boat refuses a delete unless the confirmation header names the sandbox.
    deleteSandbox: (sandboxId: string) =>
      send(
        "delete a machine",
        HttpClientRequest.delete(sandboxPath(sandboxId)).pipe(
          HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", sandboxId),
        ),
      ).pipe(Effect.asVoid),

    runCommand: (
      sandboxId: string,
      input: { readonly command: string; readonly timeoutSeconds?: number },
    ) =>
      send(
        "run a command on a machine",
        HttpClientRequest.post(`${sandboxPath(sandboxId)}/commands`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            command: input.command,
            timeoutSeconds: input.timeoutSeconds ?? 30,
          }),
        ),
      ).pipe(Effect.flatMap(decoder("run a command on a machine", decodeCommandResult))),

    startDetached: (sandboxId: string, command: string) =>
      send(
        "start a process on a machine",
        HttpClientRequest.post(`${sandboxPath(sandboxId)}/commands`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ command, detached: true }),
        ),
      ).pipe(Effect.asVoid),

    hostPublicPort: (sandboxId: string, port: number) =>
      send(
        "publish a machine's port",
        HttpClientRequest.post(`${sandboxPath(sandboxId)}/host`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ port, public: true }),
        ),
      ).pipe(
        Effect.flatMap(decoder("publish a machine's port", decodeHostedPort)),
        Effect.map((hosted) => hosted.url),
      ),
  };
};
export type BoatApi = ReturnType<typeof makeBoatApi>;
