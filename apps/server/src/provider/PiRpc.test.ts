import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  asRecord,
  makePiRpc,
  parsePiModelSlug,
  recordString,
  type PiRpcOptions,
  type PiRpcRecord,
} from "./PiRpc.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JsonValueText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonValue = Schema.decodeUnknownSync(JsonValueText);
const encodeJsonValue = Schema.encodeUnknownSync(JsonValueText);

type FakeWriteHandler = (record: PiRpcRecord) => Effect.Effect<void, PlatformError.PlatformError>;

interface FakeProcessOptions {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly onWrite?: FakeWriteHandler;
  readonly onKill?: (options: ChildProcess.KillOptions | undefined) => void;
}

function fakeProcessHandle(options: FakeProcessOptions = {}) {
  const stdin =
    options.stdin ??
    Sink.forEach((chunk: Uint8Array) => {
      const line = decoder.decode(chunk).replace(/\n$/, "");
      const parsed = asRecord(decodeJsonValue(line));
      if (parsed === undefined) {
        return Effect.die("Expected an outbound JSON object");
      }
      return options.onWrite?.(parsed) ?? Effect.void;
    });

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: options.exitCode ?? Effect.never,
    isRunning: Effect.succeed(true),
    kill: (killOptions) =>
      Effect.sync(() => {
        options.onKill?.(killOptions);
      }),
    unref: Effect.succeed(Effect.void),
    stdin,
    stdout: options.stdout ?? Stream.fromEffect(Effect.never),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeSpawner(
  handle: ChildProcessSpawner.ChildProcessHandle,
  onSpawn?: (command: ChildProcess.Command) => void,
) {
  return ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      onSpawn?.(command);
      return handle;
    }),
  );
}

function makeTestClient(
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: Partial<PiRpcOptions> = {},
) {
  return makePiRpc({
    binaryPath: "pi",
    cwd: "/workspace",
    ...options,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeSpawner(handle)),
    Effect.provideService(HostProcessPlatform, "linux"),
  );
}

function jsonLine(record: PiRpcRecord, crlf = false): Uint8Array {
  return encoder.encode(`${encodeJsonValue(record)}${crlf ? "\r\n" : "\n"}`);
}

function responseFor(request: PiRpcRecord, data?: unknown): PiRpcRecord {
  return {
    id: recordString(request, "id"),
    type: "response",
    command: recordString(request, "type"),
    success: true,
    ...(data === undefined ? {} : { data }),
  };
}

describe("Pi RPC JSONL framing", () => {
  it.effect("frames only on LF across arbitrary byte chunks and strips an optional CR", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = { type: "event", text: "left\u2028middle\u2029right" } satisfies PiRpcRecord;
        const bytes = new Uint8Array([...jsonLine(first, true), ...jsonLine({ type: "second" })]);
        const unicodeStart = bytes.indexOf(0xe2);
        const chunks = [
          bytes.subarray(0, 2),
          bytes.subarray(2, unicodeStart + 1),
          bytes.subarray(unicodeStart + 1, unicodeStart + 2),
          bytes.subarray(unicodeStart + 2, bytes.length - 3),
          bytes.subarray(bytes.length - 3),
        ];
        const client = yield* makeTestClient(
          fakeProcessHandle({ stdout: Stream.fromIterable(chunks) }),
        );

        const events = Array.from(yield* client.events.pipe(Stream.take(2), Stream.runCollect));
        expect(events).toEqual([first, { type: "second" }]);
      }),
    ),
  );

  it.effect("emits bounded metadata for malformed and oversized records without raw output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = Stream.make(
          encoder.encode("not-json\n[]\n"),
          encoder.encode(`${"x".repeat(40)}\n`),
          jsonLine({ type: "valid" }),
        );
        const client = yield* makeTestClient(fakeProcessHandle({ stdout }), {
          maxRecordBytes: 16,
          maxMalformedRecordEvents: 3,
        });

        const events = Array.from(yield* client.events.pipe(Stream.take(4), Stream.runCollect));
        expect(events).toEqual([
          { type: "pi_rpc_malformed_record", reason: "invalid-json", byteLength: 8 },
          { type: "pi_rpc_malformed_record", reason: "invalid-record", byteLength: 2 },
          { type: "pi_rpc_malformed_record", reason: "record-too-large", byteLength: 40 },
          { type: "valid" },
        ]);
        expect(encodeJsonValue(events)).not.toContain("not-json");
      }),
    ),
  );
});

describe("Pi RPC request routing", () => {
  it.effect("correlates generated request ids while routing asynchronous events separately", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const observedRequests: PiRpcRecord[] = [];
        const handle = fakeProcessHandle({
          stdout: Stream.fromQueue(stdout),
          onWrite: (request) =>
            Effect.gen(function* () {
              observedRequests.push(request);
              yield* Queue.offer(stdout, jsonLine({ type: "message_update", delta: "hello" }));
              yield* Queue.offer(stdout, jsonLine(responseFor(request, { accepted: true })));
            }),
        });
        const client = yield* makeTestClient(handle);

        const response = yield* client.request({ type: "prompt", message: "private prompt" });
        const event = yield* client.events.pipe(Stream.runHead);

        expect(observedRequests).toHaveLength(1);
        expect(recordString(observedRequests[0]!, "id")).toMatch(/^t3-pi-\d+$/);
        expect(response.id).toBe(recordString(observedRequests[0]!, "id"));
        expect(response.data).toEqual({ accepted: true });
        expect(event._tag).toBe("Some");
        if (event._tag === "Some") {
          expect(event.value).toEqual({ type: "message_update", delta: "hello" });
        }
      }),
    ),
  );

  it.effect("correlates concurrent requests when responses arrive out of order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const observedRequests: PiRpcRecord[] = [];
        const handle = fakeProcessHandle({
          stdout: Stream.fromQueue(stdout),
          onWrite: (request) =>
            Effect.gen(function* () {
              observedRequests.push(request);
              if (observedRequests.length !== 2) return;
              yield* Queue.offer(stdout, jsonLine(responseFor(observedRequests[1]!, "second")));
              yield* Queue.offer(stdout, jsonLine(responseFor(observedRequests[0]!, "first")));
            }),
        });
        const client = yield* makeTestClient(handle);

        const first = yield* client.request({ type: "get_state" }).pipe(Effect.forkChild);
        const second = yield* client.request({ type: "get_commands" }).pipe(Effect.forkChild);

        expect((yield* Fiber.join(first)).data).toBe("first");
        expect((yield* Fiber.join(second)).data).toBe("second");
        expect(yield* client.pendingRequestCount).toBe(0);
      }),
    ),
  );

  it.effect("routes unknown responses as diagnostics without disturbing pending requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const handle = fakeProcessHandle({
          stdout: Stream.fromQueue(stdout),
          onWrite: (request) =>
            Effect.gen(function* () {
              yield* Queue.offer(
                stdout,
                jsonLine({
                  id: "unknown-request",
                  type: "response",
                  command: "get_state",
                  success: true,
                }),
              );
              yield* Queue.offer(stdout, jsonLine(responseFor(request)));
            }),
        });
        const client = yield* makeTestClient(handle);

        const response = yield* client.request({ type: "get_state" });
        const diagnostic = yield* client.events.pipe(Stream.runHead);

        expect(response.command).toBe("get_state");
        expect(diagnostic._tag).toBe("Some");
        if (diagnostic._tag === "Some") {
          expect(diagnostic.value).toEqual({
            type: "pi_rpc_malformed_record",
            reason: "unknown-response",
            byteLength: expect.any(Number),
          });
        }
      }),
    ),
  );

  it.effect("rejects malformed response envelopes for known requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const handle = fakeProcessHandle({
          stdout: Stream.fromQueue(stdout),
          onWrite: (request) =>
            Queue.offer(
              stdout,
              jsonLine({
                id: recordString(request, "id"),
                type: "response",
                command: "wrong-command",
                success: true,
              }),
            ).pipe(Effect.asVoid),
        });
        const client = yield* makeTestClient(handle);

        const error = yield* client.request({ type: "get_state" }).pipe(Effect.flip);

        expect(error.reason).toBe("malformed-response");
        expect(yield* client.pendingRequestCount).toBe(0);
      }),
    ),
  );

  it.effect("bounds remote errors and does not copy request payloads into transport errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const handle = fakeProcessHandle({
          stdout: Stream.fromQueue(stdout),
          onWrite: (request) =>
            Queue.offer(
              stdout,
              jsonLine({
                id: recordString(request, "id"),
                type: "response",
                command: recordString(request, "type"),
                success: false,
                error: `remote-${"x".repeat(100)}`,
              }),
            ).pipe(Effect.asVoid),
        });
        const client = yield* makeTestClient(handle, { maxRemoteErrorChars: 24 });

        const error = yield* client
          .request({ type: "prompt", message: "must-not-appear" })
          .pipe(Effect.flip);

        expect(error.reason).toBe("remote-error");
        expect(error.detail.length).toBe(24);
        expect(error.message).not.toContain("must-not-appear");
      }),
    ),
  );

  it.effect("rejects a pending request when stdout reaches EOF", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestWritten = yield* Deferred.make<void>();
        const stdout = Stream.fromEffect(Deferred.await(requestWritten)).pipe(Stream.drain);
        const client = yield* makeTestClient(
          fakeProcessHandle({
            stdout,
            onWrite: () => Deferred.succeed(requestWritten, undefined).pipe(Effect.asVoid),
          }),
        );

        const error = yield* client.request({ type: "get_state" }).pipe(Effect.flip);
        expect(error.reason).toBe("stdout-eof");
        expect(yield* client.pendingRequestCount).toBe(0);
      }),
    ),
  );

  it.effect("rejects pending requests when the child process exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestWritten = yield* Deferred.make<void>();
        const processExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const client = yield* makeTestClient(
          fakeProcessHandle({
            exitCode: Deferred.await(processExit),
            onWrite: () => Deferred.succeed(requestWritten, undefined).pipe(Effect.asVoid),
          }),
        );

        const requestFiber = yield* client.request({ type: "get_state" }).pipe(Effect.forkChild);
        yield* Deferred.await(requestWritten);
        yield* Deferred.succeed(processExit, ChildProcessSpawner.ExitCode(7));
        const error = yield* Fiber.join(requestFiber).pipe(Effect.flip);

        expect(error.reason).toBe("process-exited");
        expect(error.detail).toContain("code 7");
        expect(yield* client.pendingRequestCount).toBe(0);
      }),
    ),
  );

  it.effect("cleans up a timed-out request", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const requestWritten = yield* Deferred.make<void>();
          const client = yield* makeTestClient(
            fakeProcessHandle({
              onWrite: () => Deferred.succeed(requestWritten, undefined).pipe(Effect.asVoid),
            }),
            { requestTimeout: "1 second" },
          );

          const requestFiber = yield* client.request({ type: "get_state" }).pipe(Effect.forkChild);
          yield* Deferred.await(requestWritten);
          expect(yield* client.pendingRequestCount).toBe(1);
          yield* TestClock.adjust("1 second");
          const error = yield* Fiber.join(requestFiber).pipe(Effect.flip);

          expect(error.reason).toBe("request-timeout");
          expect(yield* client.pendingRequestCount).toBe(0);
        }),
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cleans up interrupted requests and synchronous write failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestWritten = yield* Deferred.make<void>();
        const client = yield* makeTestClient(
          fakeProcessHandle({
            onWrite: () => Deferred.succeed(requestWritten, undefined).pipe(Effect.asVoid),
          }),
        );
        const requestFiber = yield* client.request({ type: "get_state" }).pipe(Effect.forkChild);
        yield* Deferred.await(requestWritten);
        yield* Fiber.interrupt(requestFiber);
        expect(yield* client.pendingRequestCount).toBe(0);

        const writeCause = PlatformError.systemError({
          _tag: "WriteZero",
          module: "PiRpcTest",
          method: "write",
        });
        const failedClient = yield* makeTestClient(
          fakeProcessHandle({ stdin: Sink.fail(writeCause) }),
        );
        const writeError = yield* failedClient.request({ type: "get_state" }).pipe(Effect.flip);
        expect(writeError.reason).toBe("write-failed");
        expect(yield* failedClient.pendingRequestCount).toBe(0);
      }),
    ),
  );

  it.effect("fails pending requests when the transport scope closes", () =>
    Effect.gen(function* () {
      const requestWritten = yield* Deferred.make<void>();
      const transportScope = yield* Scope.make();
      const client = yield* makeTestClient(
        fakeProcessHandle({
          onWrite: () => Deferred.succeed(requestWritten, undefined).pipe(Effect.asVoid),
        }),
      ).pipe(Effect.provideService(Scope.Scope, transportScope));
      const requestFiber = yield* client.request({ type: "get_state" }).pipe(Effect.forkChild);
      yield* Deferred.await(requestWritten);

      yield* Scope.close(transportScope, Exit.void);
      const error = yield* Fiber.join(requestFiber).pipe(Effect.flip);

      expect(error.reason).toBe("closed");
      expect(yield* client.pendingRequestCount).toBe(0);
    }),
  );

  it.effect("launches resumed RPC sessions by full id without a host path", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.Command | undefined;
      const sessionId = "0195d9c0-1234-7000-8000-000000000001";

      yield* Effect.scoped(
        makePiRpc({ binaryPath: "pi", cwd: "/workspace", sessionId }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner(fakeProcessHandle(), (command) => {
              spawnedCommand = command;
            }),
          ),
          Effect.provideService(HostProcessPlatform, "linux"),
        ),
      );

      expect(spawnedCommand?._tag).toBe("StandardCommand");
      if (spawnedCommand?._tag === "StandardCommand") {
        expect(spawnedCommand.args).toEqual(["--mode", "rpc", "--session", sessionId]);
        expect(spawnedCommand.options.cwd).toBe("/workspace");
      }
    }),
  );

  it.effect("uses scoped process-tree teardown settings", () =>
    Effect.gen(function* () {
      const kills: Array<ChildProcess.KillOptions | undefined> = [];
      let spawnedCommand: ChildProcess.Command | undefined;
      const handle = fakeProcessHandle({ onKill: (options) => kills.push(options) });

      yield* Effect.scoped(
        makePiRpc({ binaryPath: "pi", cwd: "/workspace" }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner(handle, (command) => {
              spawnedCommand = command;
            }),
          ),
          Effect.provideService(HostProcessPlatform, "linux"),
        ),
      );

      expect(spawnedCommand?._tag).toBe("StandardCommand");
      if (spawnedCommand?._tag === "StandardCommand") {
        expect(spawnedCommand.args).toEqual(["--mode", "rpc"]);
        expect(spawnedCommand.options.detached).toBe(true);
        expect(spawnedCommand.options.stdin).toEqual({ stream: "pipe", endOnDone: false });
      }
      expect(kills).toEqual([{ killSignal: "SIGTERM", forceKillAfter: expect.anything() }]);
    }),
  );
});

describe("Pi model slug parsing", () => {
  it("parses provider, nested model ids, and recognized thinking levels", () => {
    expect(parsePiModelSlug("openai/gpt-5.2:high")).toEqual({
      provider: "openai",
      modelId: "gpt-5.2",
      thinkingLevel: "high",
    });
    expect(parsePiModelSlug("openrouter/meta-llama/llama-3.3:free")).toEqual({
      provider: "openrouter",
      modelId: "meta-llama/llama-3.3:free",
    });
    expect(parsePiModelSlug(" anthropic / claude-sonnet-4 ")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  it("rejects incomplete provider/model slugs", () => {
    expect(parsePiModelSlug("claude-sonnet-4")).toBeUndefined();
    expect(parsePiModelSlug("/claude-sonnet-4")).toBeUndefined();
    expect(parsePiModelSlug("anthropic/")).toBeUndefined();
    expect(parsePiModelSlug("anthropic/:max")).toBeUndefined();
  });
});
