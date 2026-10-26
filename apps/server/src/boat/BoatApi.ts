import { BoatError, type BoatSize } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const BOAT_API_URL = "https://boat.dev/api/v1";

// Only the fields T3 Code reads; Boat's responses carry many more. Create and read both wrap the
// sandbox in `sandbox` (docs.boat.dev/openapi/boat-v1.yaml).
const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  // The stable label in its public URLs, `https://<subdomain>-<port>.on.boat.dev`.
  subdomain: Schema.optional(Schema.NullOr(Schema.String)),
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

const NamedSnapshots = Schema.Struct({
  snapshots: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      createdAt: Schema.String,
      // `saving` until Boat can start a machine from it, then `ready`.
      status: Schema.optional(Schema.String),
      snapshotId: Schema.optional(Schema.String),
      sourceSandboxId: Schema.optional(Schema.String),
    }),
  ),
  allowance: Schema.optional(Schema.Struct({ free: Schema.optional(Schema.Number) })),
});
// Boat's free named snapshots per wallet, when it does not say.
const FREE_NAMED_SNAPSHOTS = 10;

const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/** Sandbox states in which commands run. */
export const BOAT_READY_STATES: ReadonlySet<string> = new Set(["ready", "idle", "running"]);
/** Sandbox states it never leaves on its own. */
export const BOAT_TERMINAL_STATES: ReadonlySet<string> = new Set(["error", "cancelled"]);
/** Sandbox states that end a first start; a resume passes through `archived` instead. */
export const BOAT_START_FAILED_STATES: ReadonlySet<string> = new Set([
  ...BOAT_TERMINAL_STATES,
  "archiving",
  "archived",
]);

const decoder =
  <A>(operation: string, decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  (body: unknown) =>
    decode(body).pipe(
      Effect.mapError(
        () => new BoatError({ detail: `Boat answered unexpectedly when asked to ${operation}.` }),
      ),
    );

const decodeSandboxResponse = Schema.decodeUnknownEffect(SandboxResponse);
const decodeCommandResult = Schema.decodeUnknownEffect(CommandResult);
const decodeHostedPort = Schema.decodeUnknownEffect(HostedPort);
const decodeNamedSnapshots = Schema.decodeUnknownEffect(NamedSnapshots);

/** A Boat REST client for one API key. */
export const makeBoatApi = (httpClient: HttpClient.HttpClient, apiKey: string) => {
  // Boat's status and JSON body; only a failed request is an error here.
  const exchange = Effect.fn("BoatApi.exchange")(function* (
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
    return { status: response.status, body };
  });

  const refusal = (operation: string, status: number, body: unknown) => {
    const detail = Option.getOrUndefined(decodeErrorBody(body))?.message;
    return new BoatError({
      detail: `Boat could not ${operation} (HTTP ${status})${detail ? `: ${detail}` : "."}`,
    });
  };

  // Boat's JSON answer, or its error message as a BoatError.
  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    exchange(operation, request).pipe(
      Effect.flatMap(({ status, body }) =>
        status >= 200 && status < 300
          ? Effect.succeed(body)
          : Effect.fail(refusal(operation, status, body)),
      ),
    );

  // Like send, but a sandbox Boat no longer has is None rather than an error.
  const sendForSandbox = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    exchange(operation, request).pipe(
      Effect.flatMap(({ status, body }) =>
        status === 404
          ? Effect.succeedNone
          : status >= 200 && status < 300
            ? Effect.succeedSome(body)
            : Effect.fail(refusal(operation, status, body)),
      ),
    );

  const sandboxPath = (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}`;

  return {
    /** `from` names a template or a named snapshot. */
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

    /** None once Boat no longer has the sandbox. */
    getSandbox: (sandboxId: string) =>
      sendForSandbox("read a machine", HttpClientRequest.get(sandboxPath(sandboxId))).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (body) =>
              decoder(
                "read a machine",
                decodeSandboxResponse,
              )(body).pipe(Effect.map((response) => Option.some(response.sandbox))),
          }),
        ),
      ),

    stopSandbox: (sandboxId: string) =>
      send(
        "stop a machine",
        HttpClientRequest.post(`${sandboxPath(sandboxId)}/stop`).pipe(
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      ).pipe(Effect.asVoid),

    /** "expired" once Boat no longer has the stopped disk: deleted, or kept past its 14 free days. */
    resumeSandbox: (sandboxId: string, ttlSeconds: number) =>
      exchange(
        "resume a machine",
        HttpClientRequest.post(`${sandboxPath(sandboxId)}/resume`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ ttlSeconds }),
        ),
      ).pipe(
        Effect.flatMap(({ status, body }) =>
          status >= 200 && status < 300
            ? Effect.succeed("resumed" as const)
            : status === 404 ||
                (status === 409 &&
                  Option.getOrUndefined(decodeErrorBody(body))?.code === "snapshot_data_expired")
              ? Effect.succeed("expired" as const)
              : Effect.fail(refusal("resume a machine", status, body)),
        ),
      ),

    /** Boat stops the machine this long from now, unless asked again. */
    extendSandbox: (sandboxId: string, ttlSeconds: number) =>
      send(
        "keep a machine running",
        HttpClientRequest.patch(sandboxPath(sandboxId)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ ttlSeconds }),
        ),
      ).pipe(Effect.asVoid),

    /** Points the machine's public URLs at a new subdomain, which must be free. */
    renameSandbox: (sandboxId: string, subdomain: string) =>
      send(
        "move a machine's address",
        HttpClientRequest.patch(sandboxPath(sandboxId)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ subdomain }),
        ),
      ).pipe(Effect.asVoid),

    listNamedSnapshots: () =>
      send("list named snapshots", HttpClientRequest.get("/named-snapshots")).pipe(
        Effect.flatMap(decoder("list named snapshots", decodeNamedSnapshots)),
        Effect.map((response) => ({
          snapshots: response.snapshots,
          free: response.allowance?.free ?? FREE_NAMED_SNAPSHOTS,
        })),
      ),

    // Boat saves in the background; a stopped machine's disk is frozen already, so the save
    // only has to start.
    saveNamedSnapshot: (sandboxId: string, name: string) =>
      send(
        "save a named snapshot",
        HttpClientRequest.post("/named-snapshots").pipe(
          HttpClientRequest.bodyJsonUnsafe({ sandboxId, name }),
        ),
      ).pipe(Effect.asVoid),

    // One already gone counts as removed.
    deleteNamedSnapshot: (name: string) =>
      sendForSandbox(
        "remove a named snapshot",
        HttpClientRequest.delete(`/named-snapshots/${encodeURIComponent(name)}`),
      ).pipe(Effect.asVoid),

    // Boat refuses a delete unless the confirmation header names the sandbox. One already gone
    // counts as deleted.
    deleteSandbox: (sandboxId: string) =>
      sendForSandbox(
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
