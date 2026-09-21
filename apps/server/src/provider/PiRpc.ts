import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(30);
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_REMOTE_ERROR_CHARS = 2_048;
const DEFAULT_MAX_MALFORMED_RECORD_EVENTS = 32;
const PROCESS_FORCE_KILL_AFTER = Duration.seconds(1);

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const JsonRecordText = Schema.fromJsonString(JsonRecord);
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJsonRecord = Schema.encodeEffect(JsonRecordText);
const isJsonRecord = Schema.is(JsonRecord);

export type PiRpcRecord = Schema.Schema.Type<typeof JsonRecord>;

/** Return an object record at an untrusted JSON boundary, rejecting arrays and null. */
export function asRecord(value: unknown): PiRpcRecord | undefined {
  return isJsonRecord(value) ? value : undefined;
}

export function recordString(record: PiRpcRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function recordBoolean(record: PiRpcRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function recordArray(record: PiRpcRecord, key: string): ReadonlyArray<unknown> | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface PiModelSlug {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: PiThinkingLevel;
}

const piThinkingLevels = new Set<string>(PI_THINKING_LEVELS);

/** Parse Pi's `provider/model` slug and its optional recognized `:thinking` suffix. */
export function parsePiModelSlug(slug: string): PiModelSlug | undefined {
  const normalized = slug.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) {
    return undefined;
  }

  const provider = normalized.slice(0, separator).trim();
  let modelId = normalized.slice(separator + 1).trim();
  if (provider.length === 0 || modelId.length === 0) {
    return undefined;
  }

  const thinkingSeparator = modelId.lastIndexOf(":");
  const possibleThinkingLevel =
    thinkingSeparator === -1 ? undefined : modelId.slice(thinkingSeparator + 1);
  if (possibleThinkingLevel && piThinkingLevels.has(possibleThinkingLevel)) {
    modelId = modelId.slice(0, thinkingSeparator);
    if (modelId.length === 0) {
      return undefined;
    }
    return {
      provider,
      modelId,
      thinkingLevel: possibleThinkingLevel as PiThinkingLevel,
    };
  }

  return { provider, modelId };
}

export type PiRpcErrorReason =
  | "spawn-failed"
  | "closed"
  | "stdout-eof"
  | "stdout-failed"
  | "process-exited"
  | "write-failed"
  | "request-timeout"
  | "remote-error"
  | "malformed-response";

export class PiRpcError extends Schema.TaggedError<PiRpcError>()("PiRpcError", {
  reason: Schema.Literals([
    "spawn-failed",
    "closed",
    "stdout-eof",
    "stdout-failed",
    "process-exited",
    "write-failed",
    "request-timeout",
    "remote-error",
    "malformed-response",
  ]),
  detail: Schema.String,
  method: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const method = this.method === undefined ? "" : ` for ${this.method}`;
    return `Pi RPC ${this.reason}${method}: ${this.detail}`;
  }
}

export interface PiRpcMalformedRecordEvent {
  readonly type: "pi_rpc_malformed_record";
  readonly reason:
    | "invalid-json"
    | "invalid-record"
    | "record-too-large"
    | "unterminated-record"
    | "unknown-response";
  readonly byteLength: number;
}

export interface PiRpcTransportClosedEvent {
  readonly type: "pi_rpc_transport_closed";
  readonly error: PiRpcError;
}

export type PiRpcEvent = PiRpcRecord | PiRpcMalformedRecordEvent | PiRpcTransportClosedEvent;

export type PiRpcResponse = PiRpcRecord & {
  readonly id: string;
  readonly type: "response";
  readonly command: string;
  readonly success: true;
};

export type PiRpcCommand = PiRpcRecord & {
  readonly type: string;
};

export interface PiRpcClient {
  /** Send a correlated command. Remote `success: false` responses fail the effect. */
  readonly request: (
    command: PiRpcCommand,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<PiRpcResponse, PiRpcError>;
  /** Write a fire-and-forget protocol record, such as an extension UI response. */
  readonly notify: (record: PiRpcRecord) => Effect.Effect<void, PiRpcError>;
  /** Asynchronous Pi events and bounded transport diagnostics. */
  readonly events: Stream.Stream<PiRpcEvent>;
  /** Primarily useful for health reporting and deterministic lifecycle tests. */
  readonly pendingRequestCount: Effect.Effect<number>;
  readonly pid: ChildProcessSpawner.ProcessId;
}

export interface PiRpcOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly args?: ReadonlyArray<string>;
  /** Full Pi session id resolved by Pi inside the cwd-scoped session directory. */
  readonly sessionId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly requestTimeout?: Duration.Input;
  readonly maxRecordBytes?: number;
  readonly maxRemoteErrorChars?: number;
  readonly maxMalformedRecordEvents?: number;
}

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<PiRpcResponse, PiRpcError>;
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function encodeRecord(record: PiRpcRecord): Effect.Effect<Uint8Array, PiRpcError> {
  return encodeJsonRecord(record).pipe(
    Effect.map((json) => new TextEncoder().encode(`${json}\n`)),
    Effect.mapError(
      (cause) =>
        new PiRpcError({
          reason: "write-failed",
          detail: "The outbound RPC record could not be serialized.",
          cause,
        }),
    ),
  );
}

/**
 * Start one scoped Pi JSONL RPC process. The returned client is valid only while
 * the surrounding Effect scope remains open.
 */
export const makePiRpc = Effect.fn("PiRpc.make")(function* (
  options: PiRpcOptions,
): Effect.fn.Return<
  PiRpcClient,
  PiRpcError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeScope = yield* Scope.Scope;
  const hostPlatform = yield* HostProcessPlatform;
  const writeSemaphore = yield* Semaphore.make(1);
  const eventQueue = yield* Queue.unbounded<PiRpcEvent>();
  const pending = new Map<string, PendingRequest>();
  const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const maxRecordBytes = positiveInteger(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES);
  const maxRemoteErrorChars = positiveInteger(
    options.maxRemoteErrorChars,
    DEFAULT_MAX_REMOTE_ERROR_CHARS,
  );
  const maxMalformedRecordEvents = positiveInteger(
    options.maxMalformedRecordEvents,
    DEFAULT_MAX_MALFORMED_RECORD_EVENTS,
  );
  let requestSequence = 0;
  let malformedRecordEvents = 0;
  let terminalError: PiRpcError | undefined;
  let stopping = false;

  const spawnCommand = yield* resolveSpawnCommand(
    options.binaryPath,
    [
      "--mode",
      "rpc",
      ...(options.args ?? []),
      ...(options.sessionId === undefined ? [] : ["--session", options.sessionId]),
    ],
    options.environment ? { env: options.environment } : {},
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        detached: hostPlatform !== "win32",
        env: options.environment,
        extendEnv: options.environment === undefined,
        forceKillAfter: PROCESS_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
      Effect.mapError(
        (cause) =>
          new PiRpcError({
            reason: "spawn-failed",
            detail: "The Pi RPC process could not be started.",
            cause,
          }),
      ),
    );

  const failPending = Effect.fn("PiRpc.failPending")(function* (error: PiRpcError) {
    const entries = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(entries, ({ deferred }) => Deferred.fail(deferred, error), {
      discard: true,
    });
  });

  const terminate = Effect.fn("PiRpc.terminate")(function* (error: PiRpcError) {
    if (terminalError !== undefined || stopping) {
      return;
    }
    terminalError = error;
    yield* failPending(error);
    yield* Queue.offer(eventQueue, { type: "pi_rpc_transport_closed", error });
  });

  const emitMalformed = (
    reason: PiRpcMalformedRecordEvent["reason"],
    byteLength: number,
  ): Effect.Effect<void> => {
    if (malformedRecordEvents >= maxMalformedRecordEvents) {
      return Effect.void;
    }
    malformedRecordEvents += 1;
    return Queue.offer(eventQueue, {
      type: "pi_rpc_malformed_record",
      reason,
      byteLength,
    }).pipe(Effect.asVoid);
  };

  const routeRecord = Effect.fn("PiRpc.routeRecord")(function* (
    record: PiRpcRecord,
    byteLength: number,
  ) {
    if (recordString(record, "type") !== "response") {
      yield* Queue.offer(eventQueue, record);
      return;
    }

    const id = recordString(record, "id");
    if (id === undefined) {
      yield* emitMalformed("unknown-response", byteLength);
      return;
    }
    const waiting = pending.get(id);
    if (waiting === undefined) {
      yield* emitMalformed("unknown-response", byteLength);
      return;
    }
    pending.delete(id);

    const command = recordString(record, "command");
    const success = recordBoolean(record, "success");
    if (command !== waiting.method || success === undefined) {
      yield* Deferred.fail(
        waiting.deferred,
        new PiRpcError({
          reason: "malformed-response",
          method: waiting.method,
          detail: "Pi returned an invalid response envelope.",
        }),
      );
      return;
    }
    if (!success) {
      const remoteDetail = recordString(record, "error") ?? "Pi rejected the RPC request.";
      yield* Deferred.fail(
        waiting.deferred,
        new PiRpcError({
          reason: "remote-error",
          method: waiting.method,
          detail: boundedText(remoteDetail, maxRemoteErrorChars),
        }),
      );
      return;
    }

    const response = {
      ...record,
      id,
      type: "response",
      command,
      success: true,
    } satisfies PiRpcResponse;
    yield* Deferred.succeed(waiting.deferred, response);
  });

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let recordBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let droppingOversizedRecord = false;
  let oversizedRecordBytes = 0;

  const processLine = (bytes: Uint8Array): Effect.Effect<void> => {
    const framed = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    if (framed.length === 0) {
      return emitMalformed("invalid-json", bytes.length);
    }
    return Effect.sync(() => {
      try {
        return decoder.decode(framed);
      } catch {
        return undefined;
      }
    }).pipe(
      Effect.flatMap((text) => {
        if (text === undefined) {
          return emitMalformed("invalid-json", framed.length);
        }
        return Option.match(decodeJsonText(text), {
          onNone: () => emitMalformed("invalid-json", framed.length),
          onSome: (parsed) => {
            const record = asRecord(parsed);
            return record === undefined
              ? emitMalformed("invalid-record", framed.length)
              : routeRecord(record, framed.length);
          },
        });
      }),
    );
  };

  const processStdoutChunk = Effect.fn("PiRpc.processStdoutChunk")(function* (chunk: Uint8Array) {
    let offset = 0;
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, offset);
      const end = newlineIndex === -1 ? chunk.length : newlineIndex;
      const segment = chunk.subarray(offset, end);

      if (droppingOversizedRecord) {
        oversizedRecordBytes += segment.length;
      } else if (recordBuffer.length + segment.length > maxRecordBytes) {
        droppingOversizedRecord = true;
        oversizedRecordBytes = recordBuffer.length + segment.length;
        recordBuffer = new Uint8Array();
      } else {
        recordBuffer = concatBytes(recordBuffer, segment);
      }

      if (newlineIndex === -1) {
        return;
      }
      if (droppingOversizedRecord) {
        yield* emitMalformed("record-too-large", oversizedRecordBytes);
        droppingOversizedRecord = false;
        oversizedRecordBytes = 0;
      } else {
        yield* processLine(recordBuffer);
        recordBuffer = new Uint8Array();
      }
      offset = newlineIndex + 1;
    }
  });

  yield* child.stdout.pipe(
    Stream.runForEach(processStdoutChunk),
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        terminate(
          new PiRpcError({
            reason: "stdout-failed",
            detail: "The Pi RPC stdout stream failed.",
            cause,
          }),
        ),
      onSuccess: () =>
        Effect.gen(function* () {
          if (droppingOversizedRecord) {
            yield* emitMalformed("record-too-large", oversizedRecordBytes);
          } else if (recordBuffer.length > 0) {
            yield* emitMalformed("unterminated-record", recordBuffer.length);
          }
          yield* terminate(
            new PiRpcError({
              reason: "stdout-eof",
              detail: "The Pi RPC stdout stream ended.",
            }),
          );
        }),
    }),
    Effect.forkIn(runtimeScope),
  );

  // Drain stderr without retaining or logging it. Provider output may contain
  // prompt text, credentials, or extension diagnostics not safe for logs.
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(runtimeScope));

  yield* child.exitCode.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        terminate(
          new PiRpcError({
            reason: "process-exited",
            detail: "The Pi RPC process ended without an exit code.",
            cause,
          }),
        ),
      onSuccess: (exitCode) =>
        terminate(
          new PiRpcError({
            reason: "process-exited",
            detail: `The Pi RPC process exited with code ${Number(exitCode)}.`,
          }),
        ),
    }),
    Effect.forkIn(runtimeScope),
  );

  const writeRecord = (record: PiRpcRecord): Effect.Effect<void, PiRpcError> =>
    writeSemaphore.withPermit(
      Effect.gen(function* () {
        if (terminalError !== undefined) {
          return yield* terminalError;
        }
        if (stopping) {
          return yield* new PiRpcError({
            reason: "closed",
            detail: "The Pi RPC transport is closed.",
          });
        }
        const bytes = yield* encodeRecord(record);
        yield* Stream.make(bytes).pipe(
          Stream.run(child.stdin),
          Effect.mapError(
            (cause) =>
              new PiRpcError({
                reason: "write-failed",
                detail: "The Pi RPC record could not be written.",
                cause,
              }),
          ),
          Effect.tapError(terminate),
        );
      }),
    );

  const request: PiRpcClient["request"] = (command, requestOptions) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (terminalError !== undefined) {
          return yield* terminalError;
        }
        const method = recordString(command, "type");
        if (method === undefined || method.length === 0) {
          return yield* new PiRpcError({
            reason: "write-failed",
            detail: "The outbound RPC command is missing its type.",
          });
        }
        const id = `t3-pi-${++requestSequence}`;
        const deferred = yield* Deferred.make<PiRpcResponse, PiRpcError>();
        const entry = { method, deferred } satisfies PendingRequest;
        pending.set(id, entry);
        return { id, entry };
      }),
      ({ id, entry }) =>
        writeRecord({ ...command, id }).pipe(
          Effect.andThen(
            Deferred.await(entry.deferred).pipe(
              Effect.timeoutOption(requestOptions?.timeout ?? requestTimeout),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new PiRpcError({
                        reason: "request-timeout",
                        method: entry.method,
                        detail: "Pi did not respond before the request timeout.",
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
        ),
      ({ id, entry }) =>
        Effect.sync(() => {
          if (pending.get(id) === entry) {
            pending.delete(id);
          }
        }),
    );

  yield* Scope.addFinalizer(
    runtimeScope,
    Effect.gen(function* () {
      stopping = true;
      const closed =
        terminalError ??
        new PiRpcError({
          reason: "closed",
          detail: "The Pi RPC transport scope closed.",
        });
      yield* failPending(closed);
      yield* child
        .kill({ killSignal: "SIGTERM", forceKillAfter: PROCESS_FORCE_KILL_AFTER })
        .pipe(Effect.ignore);
    }),
  );

  return {
    request,
    notify: writeRecord,
    events: Stream.fromQueue(eventQueue),
    pendingRequestCount: Effect.sync(() => pending.size),
    pid: child.pid,
  } satisfies PiRpcClient;
});
