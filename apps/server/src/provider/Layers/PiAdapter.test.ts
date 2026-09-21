import {
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  PiRpcError,
  recordString,
  type PiRpcClient,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcOptions,
  type PiRpcRecord,
  type PiRpcResponse,
} from "../PiRpc.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  makePiAdapter,
  PiAdapterAttachmentReadError,
  type PiAdapterRpcFactory,
} from "./PiAdapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("pi-work");
const THREAD_ID = ThreadId.make("thread-pi");
const SECOND_THREAD_ID = ThreadId.make("thread-pi-second");
const SESSION_EVENTS = 3;

interface FakeTransport {
  readonly options: PiRpcOptions;
  readonly requests: PiRpcRecord[];
  readonly notifications: PiRpcRecord[];
  readonly events: Queue.Queue<PiRpcEvent>;
  readonly closeCount: () => number;
}

function successResponse(request: PiRpcCommand, data?: unknown): PiRpcResponse {
  return {
    id: "fake-request",
    type: "response",
    command: recordString(request, "type") ?? "unknown",
    success: true,
    ...(data === undefined ? {} : { data }),
  };
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsString(item, needle));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((item) => containsString(item, needle));
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([candidate, nested]) => candidate === key || containsKey(nested, key),
  );
}

function privateHistoryPayload(marker: string) {
  return {
    extensionSecret: marker,
    nested: { sessionFile: `/private/${marker}.jsonl` },
  };
}

function resumeCursor(sessionId: string, providerInstanceId = INSTANCE_ID, cwd = "/work/project") {
  return { version: 2 as const, sessionId, providerInstanceId, cwd };
}

function historyUser(content: string, timestamp = 1) {
  return { role: "user" as const, content, timestamp };
}

function historyUsage() {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function historyAssistant(
  content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "toolCall";
        readonly id: string;
        readonly name: string;
        readonly arguments: Readonly<Record<string, never>>;
      }
  > = [],
  timestamp = 2,
) {
  return {
    role: "assistant" as const,
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4",
    usage: historyUsage(),
    stopReason: "stop" as const,
    timestamp,
  };
}

function sessionState(index: number) {
  return {
    sessionId: `pi-session-${index}`,
    sessionFile: `/private/pi-session-${index}.jsonl`,
    model: {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "anthropic",
    },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

function makeRpcHarness(
  input: {
    readonly onRequest?: (
      request: PiRpcCommand,
      transport: FakeTransport,
    ) => Effect.Effect<PiRpcResponse, PiRpcError>;
    readonly onNotify?: (
      record: PiRpcRecord,
      transport: FakeTransport,
    ) => Effect.Effect<void, PiRpcError>;
    readonly onClose?: (transport: FakeTransport) => Effect.Effect<void>;
  } = {},
) {
  const transports: FakeTransport[] = [];
  const factory: PiAdapterRpcFactory = (options) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<PiRpcEvent>();
      const requests: PiRpcRecord[] = [];
      const notifications: PiRpcRecord[] = [];
      let closes = 0;
      const transport: FakeTransport = {
        options,
        requests,
        notifications,
        events,
        closeCount: () => closes,
      };
      transports.push(transport);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closes += 1;
        }).pipe(
          Effect.andThen(input.onClose === undefined ? Effect.void : input.onClose(transport)),
        ),
      );
      const client: PiRpcClient = {
        request: (request) => {
          requests.push(request);
          if (input.onRequest) return input.onRequest(request, transport);
          return Effect.succeed(
            recordString(request, "type") === "get_state"
              ? successResponse(request, {
                  ...sessionState(transports.length),
                  isStreaming: requests.some(
                    (observed) => recordString(observed, "type") === "prompt",
                  ),
                })
              : successResponse(request),
          );
        },
        notify: (record) =>
          Effect.sync(() => {
            notifications.push(record);
          }).pipe(
            Effect.andThen(
              input.onNotify === undefined ? Effect.void : input.onNotify(record, transport),
            ),
          ),
        events: Stream.fromQueue(events),
        pendingRequestCount: Effect.succeed(0),
        pid: ChildProcessSpawner.ProcessId(transports.length),
      };
      return client;
    });
  return { factory, transports };
}

type TestAdapter = ProviderAdapterShape<ProviderAdapterError>;

function makeAdapter(
  harness: ReturnType<typeof makeRpcHarness>,
  input: {
    readonly readFile?: (path: string) => Effect.Effect<Uint8Array, PiAdapterAttachmentReadError>;
    readonly interruptSettlementTimeout?: number;
  } = {},
) {
  return makePiAdapter({
    instanceId: INSTANCE_ID,
    binaryPath: "pi-test",
    environment: { PI_INSTANCE: "work" },
    attachmentsDir: "/private/attachments",
    normalizeWorkspaceCwd: (cwd) => cwd.replace("/./", "/"),
    rpcFactory: harness.factory,
    readFile: input.readFile ?? (() => Effect.succeed(new TextEncoder().encode("image-bytes"))),
    ...(input.interruptSettlementTimeout === undefined
      ? {}
      : { interruptSettlementTimeout: input.interruptSettlementTimeout }),
  });
}

function startSession(
  adapter: TestAdapter,
  threadId = THREAD_ID,
  modelSelection?: {
    readonly instanceId: typeof INSTANCE_ID;
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  },
) {
  return adapter.startSession({
    threadId,
    cwd: "/work/project",
    runtimeMode: "full-access",
    ...(modelSelection === undefined ? {} : { modelSelection }),
  });
}

function takeEvents(
  adapter: TestAdapter,
  count: number,
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> {
  return adapter.streamEvents.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
  );
}

function offerNative(transport: FakeTransport, event: PiRpcRecord) {
  return Queue.offer(transport.events, event).pipe(Effect.asVoid);
}

function transportClosed(transport: FakeTransport) {
  return Queue.offer(transport.events, {
    type: "pi_rpc_transport_closed",
    error: new PiRpcError({ reason: "process-exited", detail: "process exited" }),
  }).pipe(Effect.asVoid);
}

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  total: number,
  reasoning?: number,
) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: total / 4,
      output: total / 4,
      cacheRead: total / 4,
      cacheWrite: total / 4,
      total,
    },
  };
}

function assistantMessage(input: {
  readonly provider?: string;
  readonly model?: string;
  readonly usage: ReturnType<typeof usage>;
  readonly stopReason?: string;
}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: input.provider ?? "anthropic",
    model: input.model ?? "claude-sonnet-4",
    usage: input.usage,
    stopReason: input.stopReason ?? "stop",
    timestamp: 1,
  };
}

describe("PiAdapter session runtime", () => {
  it.effect("starts a persistent cwd-scoped session with Pi and T3 identities", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        const session = yield* startSession(adapter);
        const events = yield* takeEvents(adapter, SESSION_EVENTS);
        const listed = yield* adapter.listSessions();

        expect(harness.transports).toHaveLength(1);
        expect(harness.transports[0]?.options).toMatchObject({
          binaryPath: "pi-test",
          cwd: "/work/project",
          environment: { PI_INSTANCE: "work" },
        });
        expect(harness.transports[0]?.options.args).toBeUndefined();
        expect(
          harness.transports[0]?.requests.map((request) => recordString(request, "type")),
        ).toEqual(["get_state"]);
        expect(session).toMatchObject({
          provider: "pi",
          providerInstanceId: "pi-work",
          threadId: "thread-pi",
          cwd: "/work/project",
          model: "anthropic/claude-sonnet-4",
          status: "ready",
          resumeCursor: resumeCursor("pi-session-1"),
        });
        expect(events.map((event) => event.type)).toEqual([
          "session.started",
          "thread.started",
          "session.state.changed",
        ]);
        expect(events.every((event) => event.providerInstanceId === INSTANCE_ID)).toBe(true);
        expect(listed[0]?.resumeCursor).toEqual(resumeCursor("pi-session-1"));
        expect(containsKey([session, listed, events], "sessionFile")).toBe(false);
      }),
    ),
  );

  it.effect("resumes by cwd-scoped session id and routes startup model hooks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const modelAccepted = yield* Deferred.make<void>();
        const resumedState = { ...sessionState(7), sessionId: "pi-resumed-session" };
        const harness = makeRpcHarness({
          onRequest: (request, transport) => {
            const type = recordString(request, "type");
            if (type === "get_state") return Effect.succeed(successResponse(request, resumedState));
            if (type === "set_model") {
              return offerNative(transport, {
                type: "extension_ui_request",
                id: "resume-model-confirm",
                method: "confirm",
                title: "Use model?",
                message: "Allow model selection",
              }).pipe(
                Effect.andThen(Deferred.await(modelAccepted)),
                Effect.as(successResponse(request)),
              );
            }
            return Effect.succeed(successResponse(request));
          },
          onNotify: (record) =>
            recordString(record, "type") === "extension_ui_response"
              ? Deferred.succeed(modelAccepted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const adapter = yield* makeAdapter(harness);
        const cursor = resumeCursor("pi-resumed-session");
        const startFiber = yield* adapter
          .startSession({
            threadId: THREAD_ID,
            cwd: "/work/./project",
            runtimeMode: "full-access",
            resumeCursor: cursor,
            modelSelection: {
              instanceId: INSTANCE_ID,
              model: "openai/gpt-5.2",
              options: [{ id: "thinkingLevel", value: "high" }],
            },
          })
          .pipe(Effect.forkChild);
        const opened = (yield* takeEvents(adapter, 1))[0];
        yield* adapter.respondToRequest(
          THREAD_ID,
          ApprovalRequestId.make("resume-model-confirm"),
          "accept",
        );
        const session = yield* Fiber.join(startFiber);
        const startupEvents = yield* takeEvents(adapter, SESSION_EVENTS);

        expect(opened).toMatchObject({
          type: "request.opened",
          requestId: "resume-model-confirm",
        });
        expect(harness.transports).toHaveLength(1);
        expect(harness.transports[0]?.options).toMatchObject({
          cwd: "/work/project",
          sessionId: "pi-resumed-session",
        });
        expect(
          harness.transports[0]?.requests.map((request) => recordString(request, "type")),
        ).toEqual(["get_state", "set_model", "set_thinking_level"]);
        expect(
          harness.transports[0]?.requests.some(
            (request) => recordString(request, "type") === "switch_session",
          ),
        ).toBe(false);
        expect(session).toMatchObject({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/work/project",
          resumeCursor: cursor,
        });
        expect(containsKey(session, "sessionFile")).toBe(false);
        expect(containsKey(startupEvents, "sessionFile")).toBe(false);
      }),
    ),
  );

  it.effect("rejects invalid, cross-instance, and cross-workspace cursors before launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        for (const cursor of [
          { sessionId: "legacy", sessionFile: "/private/legacy.jsonl" },
          { version: 1, sessionId: "legacy", sessionFile: "/private/legacy.jsonl" },
          { version: 2, sessionId: "missing-bindings" },
          resumeCursor("invalid/session"),
          resumeCursor("cross-instance", ProviderInstanceId.make("pi-other")),
          resumeCursor("cross-workspace", INSTANCE_ID, "/work/other"),
        ]) {
          const failure = yield* adapter
            .startSession({
              threadId: THREAD_ID,
              cwd: "/work/project",
              runtimeMode: "full-access",
              resumeCursor: cursor,
            })
            .pipe(Effect.flip);
          expect(failure).toMatchObject({
            _tag: "ProviderAdapterValidationError",
            operation: "startSession",
          });
        }
        expect(harness.transports).toHaveLength(0);
      }),
    ),
  );

  it.effect("fails closed on resumed identity mismatch and permits a clean retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness({
          onRequest: (request, transport) =>
            Effect.succeed(
              successResponse(request, {
                ...sessionState(harness.transports.indexOf(transport) + 1),
                sessionId:
                  harness.transports.indexOf(transport) === 0
                    ? "wrong-session"
                    : "expected-session",
              }),
            ),
        });
        const adapter = yield* makeAdapter(harness);
        const cursor = resumeCursor("expected-session");
        const input = {
          threadId: THREAD_ID,
          cwd: "/work/project",
          runtimeMode: "full-access" as const,
          resumeCursor: cursor,
        };

        const failure = yield* adapter.startSession(input).pipe(Effect.flip);
        const restarted = yield* adapter.startSession(input);

        expect(failure).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "get_state",
        });
        expect(restarted.resumeCursor).toEqual(cursor);
        expect(harness.transports).toHaveLength(2);
        expect(harness.transports[0]?.closeCount()).toBe(1);
        expect(harness.transports[1]?.closeCount()).toBe(0);
      }),
    ),
  );

  it.effect("tears down the session scope when startup RPC requests fail", () =>
    Effect.forEach(
      ["get_state", "set_model"] as const,
      (failedCommand) =>
        Effect.scoped(
          Effect.gen(function* () {
            const harness = makeRpcHarness({
              onRequest: (request) =>
                recordString(request, "type") === failedCommand
                  ? Effect.fail(
                      new PiRpcError({
                        reason: "remote-error",
                        detail: `${failedCommand} failed`,
                        method: failedCommand,
                      }),
                    )
                  : Effect.succeed(
                      recordString(request, "type") === "get_state"
                        ? successResponse(request, sessionState(1))
                        : successResponse(request),
                    ),
            });
            const adapter = yield* makeAdapter(harness);
            const failure = yield* startSession(
              adapter,
              THREAD_ID,
              failedCommand === "set_model"
                ? { instanceId: INSTANCE_ID, model: "openai/gpt-5.2" }
                : undefined,
            ).pipe(Effect.flip);

            expect(failure._tag).toBe("ProviderAdapterRequestError");
            expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
            expect(harness.transports[0]?.closeCount()).toBe(1);
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("applies model and recognized thinking selection before prompting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter, THREAD_ID, {
          instanceId: INSTANCE_ID,
          model: "openai/gpt-5.2",
          options: [{ id: "thinkingLevel", value: "high" }],
        });
        yield* takeEvents(adapter, SESSION_EVENTS);
        const result = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Hello" });
        const started = (yield* takeEvents(adapter, 1))[0];
        const requests = harness.transports[0]!.requests;

        expect(requests.map((request) => recordString(request, "type"))).toEqual([
          "get_state",
          "set_model",
          "set_thinking_level",
          "prompt",
          "get_state",
        ]);
        expect(requests[1]).toMatchObject({ provider: "openai", modelId: "gpt-5.2" });
        expect(requests[2]).toMatchObject({ level: "high" });
        expect(requests[3]).toMatchObject({ message: "Hello" });
        expect(result.resumeCursor).toEqual(resumeCursor("pi-session-1"));
        expect(started).toMatchObject({
          type: "turn.started",
          turnId: result.turnId,
          providerInstanceId: INSTANCE_ID,
          payload: { model: "openai/gpt-5.2", effort: "high" },
        });
      }),
    ),
  );

  it.effect(
    "routes blocking model-select UI during startup before model configuration settles",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const modelAccepted = yield* Deferred.make<void>();
          const harness = makeRpcHarness({
            onRequest: (request, transport) =>
              recordString(request, "type") === "set_model"
                ? offerNative(transport, {
                    type: "extension_ui_request",
                    id: "startup-model-confirm",
                    method: "confirm",
                    title: "Use model?",
                    message: "Allow startup model selection",
                  }).pipe(
                    Effect.andThen(Deferred.await(modelAccepted)),
                    Effect.as(successResponse(request)),
                  )
                : Effect.succeed(
                    recordString(request, "type") === "get_state"
                      ? successResponse(request, sessionState(1))
                      : successResponse(request),
                  ),
            onNotify: (record) =>
              recordString(record, "type") === "extension_ui_response"
                ? Deferred.succeed(modelAccepted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          });
          const adapter = yield* makeAdapter(harness);
          const startFiber = yield* startSession(adapter, THREAD_ID, {
            instanceId: INSTANCE_ID,
            model: "openai/gpt-5.2",
          }).pipe(Effect.forkChild);
          let requestReceived = false;
          const requestFiber = yield* takeEvents(adapter, 1).pipe(
            Effect.tap(() => Effect.sync(() => (requestReceived = true))),
            Effect.forkChild,
          );
          for (let attempt = 0; attempt < 5; attempt += 1) yield* Effect.yieldNow;
          const routedBeforeModelAccepted = requestReceived;
          if (routedBeforeModelAccepted) {
            yield* adapter.respondToRequest(
              THREAD_ID,
              ApprovalRequestId.make("startup-model-confirm"),
              "accept",
            );
          } else {
            yield* Deferred.succeed(modelAccepted, undefined);
          }
          const session = yield* Fiber.join(startFiber);
          const opened = (yield* Fiber.join(requestFiber))[0]!;

          expect(routedBeforeModelAccepted).toBe(true);
          expect(opened).toMatchObject({
            type: "request.opened",
            requestId: "startup-model-confirm",
          });
          expect(session.model).toBe("openai/gpt-5.2");
          expect(harness.transports[0]?.notifications).toMatchObject([
            { type: "extension_ui_response", id: "startup-model-confirm", confirmed: true },
          ]);
        }),
      ),
  );

  it.effect("routes blocking model-select UI during turn-time model selection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const modelAccepted = yield* Deferred.make<void>();
        const harness = makeRpcHarness({
          onRequest: (request, transport) =>
            recordString(request, "type") === "set_model"
              ? offerNative(transport, {
                  type: "extension_ui_request",
                  id: "turn-model-confirm",
                  method: "confirm",
                  title: "Switch model?",
                  message: "Allow turn model selection",
                }).pipe(
                  Effect.andThen(Deferred.await(modelAccepted)),
                  Effect.as(successResponse(request)),
                )
              : Effect.succeed(
                  recordString(request, "type") === "get_state"
                    ? successResponse(request, {
                        ...sessionState(1),
                        isStreaming: transport.requests.some(
                          (observed) => recordString(observed, "type") === "prompt",
                        ),
                      })
                    : successResponse(request),
                ),
          onNotify: (record) =>
            recordString(record, "type") === "extension_ui_response"
              ? Deferred.succeed(modelAccepted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);

        const turnFiber = yield* adapter
          .sendTurn({
            threadId: THREAD_ID,
            input: "Use the selected model",
            modelSelection: { instanceId: INSTANCE_ID, model: "openai/gpt-5.2" },
          })
          .pipe(Effect.forkChild);
        let requestReceived = false;
        const requestFiber = yield* takeEvents(adapter, 1).pipe(
          Effect.tap(() => Effect.sync(() => (requestReceived = true))),
          Effect.forkChild,
        );
        for (let attempt = 0; attempt < 5; attempt += 1) yield* Effect.yieldNow;
        const routedBeforeModelAccepted = requestReceived;
        if (routedBeforeModelAccepted) {
          yield* adapter.respondToRequest(
            THREAD_ID,
            ApprovalRequestId.make("turn-model-confirm"),
            "accept",
          );
        } else {
          yield* Deferred.succeed(modelAccepted, undefined);
        }
        const result = yield* Fiber.join(turnFiber);
        const opened = (yield* Fiber.join(requestFiber))[0]!;
        const following = yield* takeEvents(adapter, routedBeforeModelAccepted ? 2 : 1);

        expect(routedBeforeModelAccepted).toBe(true);
        expect(opened).toMatchObject({
          type: "request.opened",
          requestId: "turn-model-confirm",
        });
        expect(following).toContainEqual(
          expect.objectContaining({
            type: "turn.started",
            turnId: result.turnId,
            payload: expect.objectContaining({ model: "openai/gpt-5.2" }),
          }),
        );
      }),
    ),
  );

  it.effect("settles a locally handled extension command with no agent events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness({
          onRequest: (request) =>
            Effect.succeed(
              recordString(request, "type") === "get_state"
                ? successResponse(request, sessionState(1))
                : successResponse(request),
            ),
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);

        const result = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/locally-handled" });
        const events = yield* takeEvents(adapter, 2);

        expect(
          harness.transports[0]?.requests.map((request) => recordString(request, "type")),
        ).toEqual(["get_state", "prompt", "get_state"]);
        expect(events).toMatchObject([
          { type: "turn.started", turnId: result.turnId },
          { type: "turn.completed", turnId: result.turnId, payload: { state: "completed" } },
        ]);
      }),
    ),
  );

  it.effect("routes blocking extension UI while prompt acceptance is pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const promptAccepted = yield* Deferred.make<void>();
        const harness = makeRpcHarness({
          onRequest: (request, transport) =>
            recordString(request, "type") === "prompt"
              ? offerNative(transport, {
                  type: "extension_ui_request",
                  id: "prompt-confirm",
                  method: "confirm",
                  title: "Continue?",
                  message: "Approve the extension command",
                }).pipe(
                  Effect.andThen(Deferred.await(promptAccepted)),
                  Effect.as(successResponse(request)),
                )
              : Effect.succeed(
                  recordString(request, "type") === "get_state"
                    ? successResponse(request, sessionState(1))
                    : successResponse(request),
                ),
          onNotify: (record) =>
            recordString(record, "type") === "extension_ui_response"
              ? Deferred.succeed(promptAccepted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);

        const turnFiber = yield* adapter
          .sendTurn({ threadId: THREAD_ID, input: "/needs-confirmation" })
          .pipe(Effect.forkChild);
        const started = (yield* takeEvents(adapter, 1))[0];
        let requestReceived = false;
        const requestFiber = yield* takeEvents(adapter, 1).pipe(
          Effect.tap(() => Effect.sync(() => (requestReceived = true))),
          Effect.forkChild,
        );
        for (let attempt = 0; attempt < 5; attempt += 1) yield* Effect.yieldNow;
        const requestArrivedBeforePromptAcceptance = requestReceived;
        if (!requestArrivedBeforePromptAcceptance) {
          yield* Deferred.succeed(promptAccepted, undefined);
          for (let attempt = 0; attempt < 5; attempt += 1) yield* Effect.yieldNow;
        }
        expect(requestArrivedBeforePromptAcceptance).toBe(true);
        const opened = (yield* Fiber.join(requestFiber))[0]!;
        expect(opened).toMatchObject({
          type: "request.opened",
          requestId: "prompt-confirm",
          turnId: started?.turnId,
        });

        yield* adapter.respondToRequest(
          THREAD_ID,
          ApprovalRequestId.make("prompt-confirm"),
          "accept",
        );
        const result = yield* Fiber.join(turnFiber);
        const resolved = yield* takeEvents(adapter, 2);

        expect(result.turnId).toBe(started?.turnId);
        expect(resolved).toMatchObject([
          { type: "request.resolved", requestId: "prompt-confirm" },
          { type: "turn.completed", turnId: result.turnId, payload: { state: "completed" } },
        ]);
        expect(harness.transports[0]?.notifications).toMatchObject([
          { type: "extension_ui_response", id: "prompt-confirm", confirmed: true },
        ]);
      }),
    ),
  );

  it.effect("rejects a second turn while the first prompt awaits blocking UI", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const promptAccepted = yield* Deferred.make<void>();
        const harness = makeRpcHarness({
          onRequest: (request, transport) =>
            recordString(request, "type") === "prompt"
              ? offerNative(transport, {
                  type: "extension_ui_request",
                  id: "blocking-input",
                  method: "input",
                  title: "Required input",
                  placeholder: "Value",
                }).pipe(
                  Effect.andThen(Deferred.await(promptAccepted)),
                  Effect.as(successResponse(request)),
                )
              : Effect.succeed(
                  recordString(request, "type") === "get_state"
                    ? successResponse(request, sessionState(1))
                    : successResponse(request),
                ),
          onNotify: (record) =>
            recordString(record, "type") === "extension_ui_response"
              ? Deferred.succeed(promptAccepted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);

        const firstTurn = yield* adapter
          .sendTurn({ threadId: THREAD_ID, input: "/blocking" })
          .pipe(Effect.forkChild);
        yield* takeEvents(adapter, 2);
        const rejected = yield* adapter
          .sendTurn({ threadId: THREAD_ID, input: "Must not start" })
          .pipe(Effect.flip);

        expect(rejected).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          operation: "sendTurn",
          issue: "Pi already has an active turn for this thread.",
        });
        expect(
          harness.transports[0]?.requests.filter(
            (request) => recordString(request, "type") === "prompt",
          ),
        ).toHaveLength(1);

        yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("blocking-input"), {
          "blocking-input": "continue",
        });
        yield* Fiber.join(firstTurn);
      }),
    ),
  );

  it.effect("fails and closes extension-only turns when state reconciliation fails", () =>
    Effect.forEach(
      ["request-failure", "malformed-state"] as const,
      (failure) =>
        Effect.scoped(
          Effect.gen(function* () {
            const harness = makeRpcHarness({
              onRequest: (request, transport) => {
                if (recordString(request, "type") !== "get_state") {
                  return Effect.succeed(successResponse(request));
                }
                const stateRequests = transport.requests.filter(
                  (observed) => recordString(observed, "type") === "get_state",
                ).length;
                if (stateRequests === 1) {
                  return Effect.succeed(successResponse(request, sessionState(1)));
                }
                return failure === "request-failure"
                  ? Effect.fail(
                      new PiRpcError({
                        reason: "remote-error",
                        detail: "private reconciliation failure",
                        method: "get_state",
                      }),
                    )
                  : Effect.succeed(successResponse(request, { malformed: true }));
              },
            });
            const adapter = yield* makeAdapter(harness);
            yield* startSession(adapter);
            yield* takeEvents(adapter, SESSION_EVENTS);

            const outcome = yield* adapter
              .sendTurn({ threadId: THREAD_ID, input: "/cannot-reconcile" })
              .pipe(Effect.exit);
            expect(Exit.isFailure(outcome)).toBe(true);
            const events = yield* takeEvents(adapter, 4);

            expect(events).toMatchObject([
              { type: "turn.started" },
              {
                type: "turn.completed",
                payload: {
                  state: "failed",
                  errorMessage: "Pi could not reconcile prompt state.",
                },
              },
              { type: "session.state.changed", payload: { state: "error" } },
              { type: "session.exited", payload: { exitKind: "error", recoverable: true } },
            ]);
            expect(
              events.filter(
                (event) => event.type === "turn.completed" || event.type === "turn.aborted",
              ),
            ).toHaveLength(1);
            expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
            expect(harness.transports[0]?.closeCount()).toBe(1);
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("does not reconcile an idle state after an agent run has begun", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness({
          onRequest: (request, transport) =>
            recordString(request, "type") === "prompt"
              ? offerNative(transport, { type: "agent_start" }).pipe(
                  Effect.as(successResponse(request)),
                )
              : Effect.succeed(
                  recordString(request, "type") === "get_state"
                    ? successResponse(request, sessionState(1))
                    : successResponse(request),
                ),
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const { turnId } = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Run normally" });
        yield* takeEvents(adapter, 1);

        let terminalReceived = false;
        const terminalFiber = yield* takeEvents(adapter, 1).pipe(
          Effect.tap(() => Effect.sync(() => (terminalReceived = true))),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(terminalReceived).toBe(false);

        yield* offerNative(harness.transports[0]!, { type: "agent_settled" });
        expect(yield* Fiber.join(terminalFiber)).toMatchObject([
          { type: "turn.completed", turnId, payload: { state: "completed" } },
        ]);
      }),
    ),
  );

  it.effect("normalizes text and reasoning deltas", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Explain" });
        yield* takeEvents(adapter, 1);
        const transport = harness.transports[0]!;

        yield* offerNative(transport, {
          type: "message_update",
          usage: usage(1, 1, 0, 0, 0),
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" },
        });
        yield* offerNative(transport, {
          type: "message_update",
          usage: usage(1, 2, 0, 0, 0),
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "reason" },
        });
        const events = yield* takeEvents(adapter, 2);

        expect(events).toMatchObject([
          {
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: "answer", contentIndex: 0 },
          },
          {
            type: "content.delta",
            payload: { streamKind: "reasoning_text", delta: "reason", contentIndex: 1 },
          },
        ]);
      }),
    ),
  );

  it.effect("normalizes bounded tool lifecycle payloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Run" });
        yield* takeEvents(adapter, 1);
        const transport = harness.transports[0]!;
        const oversized = `private-${"x".repeat(10_000)}`;

        yield* offerNative(transport, {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: oversized },
        });
        yield* offerNative(transport, {
          type: "tool_execution_update",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: oversized },
          partialResult: { content: [{ type: "text", text: oversized }], details: {} },
        });
        yield* offerNative(transport, {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "done" }], details: {} },
          isError: false,
        });
        const events = yield* takeEvents(adapter, 3);

        expect(events.map((event) => event.type)).toEqual([
          "item.started",
          "item.updated",
          "item.completed",
        ]);
        expect(events.every((event) => event.itemId === "tool-1")).toBe(true);
        expect(events[0]).toMatchObject({
          payload: { itemType: "command_execution", title: "bash" },
        });
        expect((events[1]?.payload as { detail?: string }).detail?.length).toBeLessThanOrEqual(
          2_048,
        );
        expect(events[2]).toMatchObject({ payload: { status: "completed", detail: "done" } });
        expect(events).not.toContainEqual(expect.objectContaining({ raw: expect.anything() }));
      }),
    ),
  );

  it.effect("routes blocking extension UI requests and exact Pi responses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const transport = harness.transports[0]!;

        yield* offerNative(transport, {
          type: "extension_ui_request",
          id: "select-1",
          method: "select",
          title: "Choose",
          options: ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"],
        });
        yield* offerNative(transport, {
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Proceed?",
          message: "Confirm operation",
        });
        yield* offerNative(transport, {
          type: "extension_ui_request",
          id: "input-1",
          method: "input",
          title: "Value",
          placeholder: "Enter value",
        });
        yield* offerNative(transport, {
          type: "extension_ui_request",
          id: "editor-1",
          method: "editor",
          title: "Edit",
          prefill: "initial",
        });
        const opened = yield* takeEvents(adapter, 4);

        expect(opened.map((event) => [event.type, event.requestId])).toEqual([
          ["user-input.requested", "select-1"],
          ["request.opened", "confirm-1"],
          ["user-input.requested", "input-1"],
          ["user-input.requested", "editor-1"],
        ]);
        expect(opened[0]).toMatchObject({
          payload: {
            questions: [
              {
                id: "select-1",
                header: "Choose",
                options: [
                  { label: "First" },
                  { label: "Second" },
                  { label: "Third" },
                  { label: "Fourth" },
                  { label: "Fifth" },
                  { label: "Sixth" },
                ],
                allowCustomAnswer: false,
              },
            ],
          },
        });
        expect(opened[2]).toMatchObject({
          payload: {
            questions: [
              {
                id: "input-1",
                header: "Value",
                question: "Enter value",
                allowCustomAnswer: true,
              },
            ],
          },
        });

        yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("select-1"), {
          "select-1": "Fifth",
        });
        yield* adapter.respondToRequest(THREAD_ID, ApprovalRequestId.make("confirm-1"), "accept");
        yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("input-1"), {
          "input-1": "typed",
        });
        yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("editor-1"), {
          "editor-1": "edited",
        });
        const resolved = yield* takeEvents(adapter, 4);

        expect(transport.notifications).toEqual([
          { type: "extension_ui_response", id: "select-1", value: "Fifth" },
          { type: "extension_ui_response", id: "confirm-1", confirmed: true },
          { type: "extension_ui_response", id: "input-1", value: "typed" },
          { type: "extension_ui_response", id: "editor-1", value: "edited" },
        ]);
        expect(resolved.map((event) => event.type)).toEqual([
          "user-input.resolved",
          "request.resolved",
          "user-input.resolved",
          "user-input.resolved",
        ]);
        const duplicate = yield* adapter
          .respondToUserInput(THREAD_ID, ApprovalRequestId.make("select-1"), {
            "select-1": "First",
          })
          .pipe(Effect.flip);
        expect(duplicate._tag).toBe("ProviderAdapterRequestError");
      }),
    ),
  );

  it.effect("expires timed extension UI requests once and rejects stale responses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const transport = harness.transports[0]!;

        yield* offerNative(transport, {
          type: "extension_ui_request",
          id: "timed-select",
          method: "select",
          title: "Choose quickly",
          options: ["One", "Two", "Three", "Four", "Five"],
          timeout: 1_000,
        });
        expect(yield* takeEvents(adapter, 1)).toMatchObject([
          { type: "user-input.requested", requestId: "timed-select" },
        ]);

        yield* TestClock.adjust("1 second");
        expect(yield* takeEvents(adapter, 1)).toMatchObject([
          {
            type: "user-input.resolved",
            requestId: "timed-select",
            payload: { answers: {} },
          },
        ]);
        const stale = yield* adapter
          .respondToUserInput(THREAD_ID, ApprovalRequestId.make("timed-select"), {
            "timed-select": "Five",
          })
          .pipe(Effect.flip);

        expect(stale._tag).toBe("ProviderAdapterRequestError");
        expect(transport.notifications).toEqual([]);
      }),
    ),
  );

  it.effect("ignores nonblocking extension UI and widget updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const transport = harness.transports[0]!;
        for (const event of [
          { type: "extension_ui_request", id: "n", method: "notify", message: "notice" },
          {
            type: "extension_ui_request",
            id: "s",
            method: "setStatus",
            statusKey: "k",
            statusText: "busy",
          },
          {
            type: "extension_ui_request",
            id: "w",
            method: "setWidget",
            widgetKey: "k",
            widgetLines: ["widget"],
          },
          { type: "extension_ui_request", id: "t", method: "setTitle", title: "title" },
          { type: "extension_ui_request", id: "e", method: "set_editor_text", text: "draft" },
        ] satisfies PiRpcRecord[]) {
          yield* offerNative(transport, event);
        }
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "next" });
        const only = yield* takeEvents(adapter, 1);

        expect(only.map((event) => event.type)).toEqual(["turn.started"]);
        expect(transport.notifications).toEqual([]);
      }),
    ),
  );

  it.effect("terminates preflight prompts on interrupt and clears blocking UI exactly once", () =>
    Effect.forEach(
      ["confirm", "input"] as const,
      (method) =>
        Effect.scoped(
          Effect.gen(function* () {
            const promptAccepted = yield* Deferred.make<PiRpcResponse, PiRpcError>();
            const requestId = `preflight-${method}`;
            const harness = makeRpcHarness({
              onRequest: (request, transport) =>
                recordString(request, "type") === "prompt"
                  ? offerNative(
                      transport,
                      method === "confirm"
                        ? {
                            type: "extension_ui_request",
                            id: requestId,
                            method,
                            title: "Continue?",
                            message: "Preflight confirmation",
                          }
                        : {
                            type: "extension_ui_request",
                            id: requestId,
                            method,
                            title: "Input needed",
                            placeholder: "Value",
                          },
                    ).pipe(Effect.andThen(Deferred.await(promptAccepted)))
                  : Effect.succeed(
                      recordString(request, "type") === "get_state"
                        ? successResponse(request, sessionState(1))
                        : successResponse(request),
                    ),
              onClose: () =>
                Deferred.fail(
                  promptAccepted,
                  new PiRpcError({ reason: "process-exited", detail: "session closed" }),
                ).pipe(Effect.asVoid),
            });
            const adapter = yield* makeAdapter(harness, { interruptSettlementTimeout: 1_000 });
            yield* startSession(adapter);
            yield* takeEvents(adapter, SESSION_EVENTS);

            const turnFiber = yield* adapter
              .sendTurn({ threadId: THREAD_ID, input: "/preflight" })
              .pipe(Effect.exit, Effect.forkChild);
            const opened = yield* takeEvents(adapter, 2);
            const turnId = opened[0]!.turnId!;
            let interruptCompleted = false;
            const interruptFiber = yield* adapter.interruptTurn(THREAD_ID, turnId).pipe(
              Effect.tap(() => Effect.sync(() => (interruptCompleted = true))),
              Effect.forkChild,
            );
            for (let attempt = 0; attempt < 5; attempt += 1) yield* Effect.yieldNow;
            const closedByInterrupt =
              interruptCompleted &&
              !(yield* adapter.hasSession(THREAD_ID)) &&
              harness.transports[0]?.closeCount() === 1;
            const abortWasSkipped = !harness.transports[0]?.requests.some(
              (request) => recordString(request, "type") === "abort",
            );

            if (!interruptCompleted) {
              yield* offerNative(harness.transports[0]!, { type: "agent_settled" });
            }
            yield* Fiber.join(interruptFiber);
            if (yield* adapter.hasSession(THREAD_ID)) yield* adapter.stopSession(THREAD_ID);
            yield* Fiber.join(turnFiber);
            const terminalEvents = yield* takeEvents(adapter, 4);
            yield* offerNative(harness.transports[0]!, { type: "agent_start" });
            yield* Effect.yieldNow;

            expect(closedByInterrupt).toBe(true);
            expect(abortWasSkipped).toBe(true);
            expect(opened).toMatchObject([
              { type: "turn.started", turnId },
              {
                type: method === "confirm" ? "request.opened" : "user-input.requested",
                requestId,
                turnId,
              },
            ]);
            expect(
              terminalEvents.filter(
                (event) => event.type === "turn.completed" || event.type === "turn.aborted",
              ),
            ).toMatchObject([
              { type: "turn.aborted", turnId, payload: { reason: "interrupted-before-prompt" } },
            ]);
            expect(terminalEvents).toContainEqual(
              expect.objectContaining({
                type: method === "confirm" ? "request.resolved" : "user-input.resolved",
                requestId,
              }),
            );
            expect(terminalEvents).toContainEqual(
              expect.objectContaining({
                type: "session.exited",
                payload: expect.objectContaining({ reason: "interrupted-before-prompt" }),
              }),
            );
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("waits for settlement when interrupting and emits one aborted terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const { turnId } = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Long task" });
        yield* takeEvents(adapter, 1);
        let interruptCompleted = false;
        const interrupt = yield* adapter.interruptTurn(THREAD_ID, turnId).pipe(
          Effect.tap(() => Effect.sync(() => (interruptCompleted = true))),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        expect(interruptCompleted).toBe(false);
        expect(harness.transports[0]?.requests.at(-1)).toMatchObject({ type: "abort" });
        yield* offerNative(harness.transports[0]!, {
          type: "agent_end",
          messages: [],
          willRetry: false,
        });
        yield* Effect.yieldNow;
        expect(interruptCompleted).toBe(false);
        yield* offerNative(harness.transports[0]!, { type: "agent_settled" });
        yield* Fiber.join(interrupt);
        const terminal = yield* takeEvents(adapter, 1);

        expect(terminal).toMatchObject([
          { type: "turn.aborted", turnId, payload: { reason: "aborted" } },
        ]);
      }),
    ),
  );

  it.effect("does not record abort intent when abort RPC fails", () =>
    Effect.forEach(
      ["write-failed", "remote-error"] as const,
      (reason) =>
        Effect.scoped(
          Effect.gen(function* () {
            const harness = makeRpcHarness({
              onRequest: (request, transport) =>
                recordString(request, "type") === "abort"
                  ? Effect.fail(
                      new PiRpcError({
                        reason,
                        detail: `abort ${reason}`,
                        method: "abort",
                      }),
                    )
                  : Effect.succeed(
                      recordString(request, "type") === "get_state"
                        ? successResponse(request, {
                            ...sessionState(1),
                            isStreaming: transport.requests.some(
                              (observed) => recordString(observed, "type") === "prompt",
                            ),
                          })
                        : successResponse(request),
                    ),
            });
            const adapter = yield* makeAdapter(harness);
            yield* startSession(adapter);
            yield* takeEvents(adapter, SESSION_EVENTS);
            const { turnId } = yield* adapter.sendTurn({
              threadId: THREAD_ID,
              input: "Do not misclassify",
            });
            yield* takeEvents(adapter, 1);

            const error = yield* adapter.interruptTurn(THREAD_ID, turnId).pipe(Effect.flip);
            expect(error).toMatchObject({
              _tag: "ProviderAdapterRequestError",
              method: "abort",
            });
            yield* offerNative(harness.transports[0]!, {
              type: "message_end",
              message: assistantMessage({ usage: usage(1, 2, 0, 0, 0.1) }),
            });
            yield* offerNative(harness.transports[0]!, { type: "agent_settled" });
            expect(yield* takeEvents(adapter, 1)).toMatchObject([
              { type: "turn.completed", turnId, payload: { state: "completed" } },
            ]);
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("closes a session when abort succeeds but settlement never arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness, {
          interruptSettlementTimeout: 1_000,
        });
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const { turnId } = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Never settles",
        });
        yield* takeEvents(adapter, 1);
        const interruption = yield* adapter.interruptTurn(THREAD_ID, turnId).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(harness.transports[0]?.requests.at(-1)).toMatchObject({ type: "abort" });
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(interruption);
        const events = yield* takeEvents(adapter, 3);

        expect(events).toMatchObject([
          {
            type: "turn.aborted",
            turnId,
            payload: { reason: "interrupt settlement timed out" },
          },
          { type: "session.state.changed", payload: { state: "error" } },
          { type: "session.exited", payload: { exitKind: "error", recoverable: true } },
        ]);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
        expect(harness.transports[0]?.closeCount()).toBe(1);
      }),
    ),
  );

  it.effect("settles only on agent_settled and deduplicates terminal races", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const { turnId } = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Complete" });
        yield* takeEvents(adapter, 1);
        const transport = harness.transports[0]!;
        yield* offerNative(transport, { type: "agent_end", messages: [], willRetry: false });
        yield* offerNative(transport, {
          type: "turn_end",
          message: assistantMessage({ usage: usage(10, 2, 3, 4, 0.5) }),
          toolResults: [],
        });
        let terminalReceived = false;
        const terminalFiber = yield* takeEvents(adapter, 1).pipe(
          Effect.tap(() => Effect.sync(() => (terminalReceived = true))),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(terminalReceived).toBe(false);
        yield* offerNative(transport, { type: "agent_settled" });
        yield* offerNative(transport, { type: "agent_settled" });
        const terminal = yield* Fiber.join(terminalFiber);
        const nextTurn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Next" });
        const afterDuplicate = yield* takeEvents(adapter, 1);

        expect(terminal).toMatchObject([
          { type: "turn.completed", turnId, payload: { state: "completed" } },
        ]);
        expect(afterDuplicate).toMatchObject([{ type: "turn.started", turnId: nextTurn.turnId }]);
      }),
    ),
  );

  it.effect("fails active work and removes the session when transport closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const { turnId } = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Crash" });
        yield* takeEvents(adapter, 1);
        yield* transportClosed(harness.transports[0]!);
        const events = yield* takeEvents(adapter, 3);

        expect(events).toMatchObject([
          { type: "turn.completed", turnId, payload: { state: "failed" } },
          { type: "session.state.changed", payload: { state: "error" } },
          { type: "session.exited", payload: { exitKind: "error", recoverable: true } },
        ]);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
        expect(yield* adapter.listSessions()).toEqual([]);
        yield* Effect.yieldNow;
        expect(harness.transports[0]?.closeCount()).toBe(1);
      }),
    ),
  );

  it.effect("owns stopSession, stopAll, listSessions, and hasSession lifecycle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter, THREAD_ID);
        yield* startSession(adapter, SECOND_THREAD_ID);
        yield* takeEvents(adapter, SESSION_EVENTS * 2);

        expect((yield* adapter.listSessions()).map((session) => session.threadId)).toEqual([
          THREAD_ID,
          SECOND_THREAD_ID,
        ]);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(true);
        yield* adapter.stopSession(THREAD_ID);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
        expect(harness.transports[0]?.closeCount()).toBe(1);
        yield* adapter.stopAll();
        expect(yield* adapter.listSessions()).toEqual([]);
        expect(harness.transports[1]?.closeCount()).toBe(1);
      }),
    ),
  );

  it.effect("encodes native images without exposing attachment paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paths: string[] = [];
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness, {
          readFile: (path) =>
            Effect.sync(() => {
              paths.push(path);
              return new TextEncoder().encode("pixel");
            }),
        });
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Inspect",
          attachments: [
            {
              type: "image",
              id: "thread-pi-00000000-0000-4000-8000-000000000001",
              name: "private.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
            {
              type: "file",
              id: "thread-pi-00000000-0000-4000-8000-000000000002-txt",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
          ],
        });
        const prompt = harness.transports[0]?.requests.find(
          (request) => recordString(request, "type") === "prompt",
        );

        expect(paths).toEqual([
          "/private/attachments/thread-pi-00000000-0000-4000-8000-000000000001.png",
        ]);
        expect(prompt).toMatchObject({
          type: "prompt",
          message: "Inspect",
          images: [{ type: "image", data: "cGl4ZWw=", mimeType: "image/png" }],
        });
        expect(prompt).not.toContain("/private/attachments");
      }),
    ),
  );

  it.effect("redacts local paths from image read failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness();
        const adapter = yield* makeAdapter(harness, {
          readFile: (path) =>
            Effect.fail(new PiAdapterAttachmentReadError({ cause: `cannot read ${path}` })),
        });
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const error = yield* adapter
          .sendTurn({
            threadId: THREAD_ID,
            input: "Inspect",
            attachments: [
              {
                type: "image",
                id: "thread-pi-00000000-0000-4000-8000-000000000001",
                name: "private.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProviderAdapterRequestError");
        expect(error.message).not.toContain("/private/attachments");
        expect(harness.transports[0]?.requests.at(-1)?.type).not.toBe("prompt");
      }),
    ),
  );

  it.effect("uses native Pi compaction and emits the compacted thread state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness({
          onRequest: (request, transport) =>
            recordString(request, "type") === "compact"
              ? Effect.gen(function* () {
                  yield* offerNative(transport, { type: "compaction_start", reason: "manual" });
                  yield* offerNative(transport, {
                    type: "compaction_end",
                    reason: "manual",
                    result: {
                      summary: "bounded away by the adapter",
                      firstKeptEntryId: "entry-2",
                      tokensBefore: 12_000,
                      estimatedTokensAfter: 2_000,
                    },
                    aborted: false,
                    willRetry: false,
                  });
                  return successResponse(request, {
                    summary: "bounded away by the adapter",
                    firstKeptEntryId: "entry-2",
                    tokensBefore: 12_000,
                    estimatedTokensAfter: 2_000,
                  });
                })
              : Effect.succeed(
                  recordString(request, "type") === "get_state"
                    ? successResponse(request, sessionState(1))
                    : successResponse(request),
                ),
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);

        expect(adapter.compaction?.type).toBe("native");
        if (adapter.compaction?.type !== "native") return;
        yield* adapter.compaction.start(THREAD_ID, {
          instanceId: INSTANCE_ID,
          model: "openai/gpt-5.2",
        });
        const compacted = (yield* takeEvents(adapter, 1))[0];
        const requests = harness.transports[0]!.requests;

        expect(requests.map((request) => recordString(request, "type"))).toEqual([
          "get_state",
          "set_model",
          "compact",
        ]);
        expect(requests.some((request) => recordString(request, "type") === "prompt")).toBe(false);
        expect(compacted).toMatchObject({
          type: "thread.state.changed",
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          payload: {
            state: "compacted",
            detail: {
              reason: "manual",
              tokensBefore: 12_000,
              estimatedTokensAfter: 2_000,
            },
          },
        });
      }),
    ),
  );

  it.effect("clears native compaction state after a remote failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeRpcHarness({
          onRequest: (request, transport) => {
            const type = recordString(request, "type");
            if (type === "compact") {
              return Effect.fail(
                new PiRpcError({
                  reason: "remote-error",
                  detail: "compaction rejected",
                  method: "compact",
                }),
              );
            }
            return Effect.succeed(
              type === "get_state"
                ? successResponse(request, {
                    ...sessionState(1),
                    isStreaming: transport.requests.some(
                      (observed) => recordString(observed, "type") === "prompt",
                    ),
                  })
                : successResponse(request),
            );
          },
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        if (adapter.compaction?.type !== "native") return;

        const failure = yield* adapter.compaction.start(THREAD_ID).pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "compact",
        });
        const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Still usable" });
        expect(yield* takeEvents(adapter, 1)).toMatchObject([
          { type: "turn.started", turnId: turn.turnId },
        ]);
      }),
    ),
  );

  it.effect("does not report failed native compaction and permits retry", () =>
    Effect.forEach(
      ["aborted", "error"] as const,
      (failureKind) =>
        Effect.scoped(
          Effect.gen(function* () {
            let attempts = 0;
            const harness = makeRpcHarness({
              onRequest: (request, transport) => {
                if (recordString(request, "type") !== "compact") {
                  return Effect.succeed(
                    recordString(request, "type") === "get_state"
                      ? successResponse(request, sessionState(1))
                      : successResponse(request),
                  );
                }
                attempts += 1;
                if (attempts === 1) {
                  return offerNative(transport, {
                    type: "compaction_end",
                    reason: "manual",
                    aborted: failureKind === "aborted",
                    willRetry: false,
                    ...(failureKind === "error"
                      ? { errorMessage: "Compaction failed: private provider detail" }
                      : {}),
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new PiRpcError({
                          reason: "remote-error",
                          detail: `${failureKind} compaction`,
                          method: "compact",
                        }),
                      ),
                    ),
                  );
                }
                return Effect.gen(function* () {
                  yield* offerNative(transport, {
                    type: "compaction_end",
                    reason: "manual",
                    result: {
                      summary: "retry succeeded",
                      firstKeptEntryId: "entry-retry",
                      tokensBefore: 9_000,
                      estimatedTokensAfter: 1_500,
                    },
                    aborted: false,
                    willRetry: false,
                  });
                  return successResponse(request, {
                    summary: "retry succeeded",
                    firstKeptEntryId: "entry-retry",
                    tokensBefore: 9_000,
                    estimatedTokensAfter: 1_500,
                  });
                });
              },
            });
            const adapter = yield* makeAdapter(harness);
            yield* startSession(adapter);
            yield* takeEvents(adapter, SESSION_EVENTS);
            if (adapter.compaction?.type !== "native") return;

            yield* adapter.compaction.start(THREAD_ID).pipe(Effect.flip);
            yield* adapter.compaction.start(THREAD_ID);
            const compacted = yield* takeEvents(adapter, 1);

            expect(compacted).toMatchObject([
              {
                type: "thread.state.changed",
                payload: {
                  state: "compacted",
                  detail: { tokensBefore: 9_000, estimatedTokensAfter: 1_500 },
                },
              },
            ]);
            expect(
              harness.transports[0]?.requests.filter(
                (request) => recordString(request, "type") === "compact",
              ),
            ).toHaveLength(2);
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("reads and groups only the authoritative active entry branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entries = [
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: historyUser("first", 1),
          },
          {
            type: "message",
            id: "assistant-1",
            parentId: "user-1",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: historyAssistant(
              [
                { type: "text", text: "answer" },
                { type: "toolCall", id: "call-1", name: "read", arguments: {} },
              ],
              2,
            ),
          },
          {
            type: "message",
            id: "tool-1",
            parentId: "assistant-1",
            timestamp: "2026-01-01T00:00:02.000Z",
            message: {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "read",
              content: [{ type: "text", text: "result" }],
              details: privateHistoryPayload("tool-result-details"),
              isError: false,
              timestamp: 3,
            },
          },
          {
            type: "message",
            id: "inactive-user",
            parentId: "assistant-1",
            timestamp: "2026-01-01T00:00:03.000Z",
            message: historyUser("inactive", 4),
          },
          {
            type: "message",
            id: "inactive-assistant",
            parentId: "inactive-user",
            timestamp: "2026-01-01T00:00:04.000Z",
            message: historyAssistant([], 5),
          },
          {
            type: "message",
            id: "user-2",
            parentId: "tool-1",
            timestamp: "2026-01-01T00:00:05.000Z",
            message: historyUser("second", 6),
          },
          {
            type: "message",
            id: "custom-role-1",
            parentId: "user-2",
            timestamp: "2026-01-01T00:00:06.000Z",
            message: {
              role: "custom",
              customType: "visible-extension-message",
              content: "visible custom content",
              display: true,
              details: privateHistoryPayload("custom-role-details"),
              timestamp: 7,
            },
          },
          {
            type: "compaction",
            id: "compact-1",
            parentId: "custom-role-1",
            timestamp: "2026-01-01T00:00:07.000Z",
            summary: "summary",
            firstKeptEntryId: "user-2",
            tokensBefore: 1200,
            details: privateHistoryPayload("compaction-details"),
          },
          {
            type: "custom",
            id: "custom-1",
            parentId: "compact-1",
            timestamp: "2026-01-01T00:00:08.000Z",
            customType: "checkpoint",
            data: privateHistoryPayload("custom-entry-data"),
          },
          {
            type: "message",
            id: "assistant-2",
            parentId: "custom-1",
            timestamp: "2026-01-01T00:00:09.000Z",
            message: historyAssistant([{ type: "text", text: "done" }], 10),
          },
        ];
        const harness = makeRpcHarness({
          onRequest: (request) =>
            Effect.succeed(
              recordString(request, "type") === "get_state"
                ? successResponse(request, sessionState(1))
                : recordString(request, "type") === "get_entries"
                  ? successResponse(request, { entries, leafId: "assistant-2" })
                  : successResponse(request),
            ),
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);

        const snapshot = yield* adapter.readThread(THREAD_ID);

        expect(snapshot.threadId).toBe(THREAD_ID);
        expect(snapshot.turns.map((turn) => turn.id)).toEqual(["user-1", "user-2"]);
        expect(snapshot.turns[0]?.items).toMatchObject([
          { id: "user-1", type: "message", role: "user", content: "first" },
          { id: "assistant-1", type: "message", role: "assistant" },
          { id: "tool-1", type: "message", role: "toolResult", toolName: "read" },
        ]);
        expect(snapshot.turns[1]?.items).toMatchObject([
          { id: "user-2", type: "message", role: "user", content: "second" },
          {
            id: "custom-role-1",
            type: "message",
            role: "custom",
            customType: "visible-extension-message",
            content: "visible custom content",
            display: true,
          },
          { id: "compact-1", type: "compaction", summary: "summary" },
          { id: "custom-1", type: "custom", customType: "checkpoint" },
          { id: "assistant-2", type: "message", role: "assistant" },
        ]);
        expect(containsString(snapshot, "inactive")).toBe(false);
        expect(containsString(snapshot, "tool-result-details")).toBe(false);
        expect(containsString(snapshot, "custom-role-details")).toBe(false);
        expect(containsString(snapshot, "compaction-details")).toBe(false);
        expect(containsString(snapshot, "custom-entry-data")).toBe(false);
        expect(containsKey(snapshot, "sessionFile")).toBe(false);
      }),
    ),
  );

  it.effect(
    "handles empty history and rejects malformed, cyclic, or disconnected entry graphs",
    () =>
      Effect.forEach(
        ["empty", "malformed", "cycle", "missing-parent"] as const,
        (caseName) =>
          Effect.scoped(
            Effect.gen(function* () {
              const data =
                caseName === "empty"
                  ? { entries: [], leafId: null }
                  : caseName === "malformed"
                    ? { entries: "invalid", leafId: null }
                    : caseName === "cycle"
                      ? {
                          entries: [
                            {
                              type: "message",
                              id: "cycle-a",
                              parentId: "cycle-b",
                              timestamp: "2026-01-01T00:00:00.000Z",
                              message: historyUser("a"),
                            },
                            {
                              type: "message",
                              id: "cycle-b",
                              parentId: "cycle-a",
                              timestamp: "2026-01-01T00:00:01.000Z",
                              message: historyAssistant(),
                            },
                          ],
                          leafId: "cycle-a",
                        }
                      : {
                          entries: [
                            {
                              type: "message",
                              id: "orphan",
                              parentId: "missing",
                              timestamp: "2026-01-01T00:00:00.000Z",
                              message: historyUser("orphan"),
                            },
                          ],
                          leafId: "orphan",
                        };
              const harness = makeRpcHarness({
                onRequest: (request) =>
                  Effect.succeed(
                    recordString(request, "type") === "get_state"
                      ? successResponse(request, sessionState(1))
                      : successResponse(request, data),
                  ),
              });
              const adapter = yield* makeAdapter(harness);
              yield* startSession(adapter);
              yield* takeEvents(adapter, SESSION_EVENTS);
              if (caseName === "empty") {
                expect(yield* adapter.readThread(THREAD_ID)).toMatchObject({ turns: [] });
              } else {
                const failure = yield* adapter.readThread(THREAD_ID).pipe(Effect.flip);
                expect(failure).toMatchObject({ _tag: "ProviderAdapterRequestError" });
              }
            }),
          ),
        { discard: true },
      ),
  );

  it.effect("decodes every authoritative Pi 0.86.1 session entry variant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = (id: string, parentId: string | null, index: number) => ({
          id,
          parentId,
          timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
        const entries = [
          {
            ...base("message", null, 0),
            type: "message",
            message: historyUser("hello"),
          },
          {
            ...base("thinking", "message", 1),
            type: "thinking_level_change",
            thinkingLevel: "high",
          },
          {
            ...base("model", "thinking", 2),
            type: "model_change",
            provider: "anthropic",
            modelId: "claude-sonnet-4",
          },
          {
            ...base("usage", "model", 3),
            type: "usage",
            kind: "cache_warm",
            provider: "anthropic",
            model: "claude-sonnet-4",
            usage: historyUsage(),
          },
          {
            ...base("compaction", "usage", 4),
            type: "compaction",
            summary: "summary",
            firstKeptEntryId: "message",
            tokensBefore: 500,
            details: privateHistoryPayload("compaction-extension"),
          },
          {
            ...base("branch", "compaction", 5),
            type: "branch_summary",
            fromId: "message",
            summary: "branch summary",
            details: privateHistoryPayload("branch-extension"),
          },
          {
            ...base("custom", "branch", 6),
            type: "custom",
            customType: "extension-state",
            data: privateHistoryPayload("custom-extension"),
          },
          {
            ...base("label", "custom", 7),
            type: "label",
            targetId: "message",
            label: "bookmark",
          },
          {
            ...base("info", "label", 8),
            type: "session_info",
            name: "Named session",
          },
          {
            ...base("custom-message", "info", 9),
            type: "custom_message",
            customType: "extension-message",
            content: "extension content",
            details: privateHistoryPayload("message-extension"),
            display: true,
          },
        ];
        const harness = makeRpcHarness({
          onRequest: (request) =>
            Effect.succeed(
              recordString(request, "type") === "get_state"
                ? successResponse(request, sessionState(1))
                : successResponse(request, { entries, leafId: "custom-message" }),
            ),
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);

        const snapshot = yield* adapter.readThread(THREAD_ID);

        expect(snapshot.turns).toHaveLength(1);
        expect(snapshot.turns[0]?.items.map((item) => (item as { type: string }).type)).toEqual([
          "message",
          "thinking_level_change",
          "model_change",
          "usage",
          "compaction",
          "branch_summary",
          "custom",
          "label",
          "session_info",
          "custom_message",
        ]);
        expect(snapshot.turns[0]?.items).toMatchObject([
          { id: "message", role: "user", content: "hello" },
          { id: "thinking", thinkingLevel: "high" },
          { id: "model", provider: "anthropic", modelId: "claude-sonnet-4" },
          { id: "usage", kind: "cache_warm", model: "claude-sonnet-4" },
          {
            id: "compaction",
            summary: "summary",
            firstKeptEntryId: "message",
            tokensBefore: 500,
          },
          { id: "branch", fromId: "message", summary: "branch summary" },
          { id: "custom", customType: "extension-state" },
          { id: "label", targetId: "message", label: "bookmark" },
          { id: "info", name: "Named session" },
          {
            id: "custom-message",
            customType: "extension-message",
            content: "extension content",
            display: true,
          },
        ]);
        expect(containsString(snapshot, "compaction-extension")).toBe(false);
        expect(containsString(snapshot, "branch-extension")).toBe(false);
        expect(containsString(snapshot, "custom-extension")).toBe(false);
        expect(containsString(snapshot, "message-extension")).toBe(false);
        expect(containsKey(snapshot, "sessionFile")).toBe(false);
      }),
    ),
  );

  it.effect("rejects unknown entry types and malformed known variants or messages", () =>
    Effect.forEach(
      [
        {
          type: "unknown",
          id: "unknown",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "custom",
          id: "custom",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "message",
          id: "message",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: { invalid: true }, timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: [], timestamp: 1 },
        },
      ],
      (entry) =>
        Effect.scoped(
          Effect.gen(function* () {
            const harness = makeRpcHarness({
              onRequest: (request) =>
                Effect.succeed(
                  recordString(request, "type") === "get_state"
                    ? successResponse(request, sessionState(1))
                    : successResponse(request, { entries: [entry], leafId: entry.id }),
                ),
            });
            const adapter = yield* makeAdapter(harness);
            yield* startSession(adapter);
            yield* takeEvents(adapter, SESSION_EVENTS);

            const failure = yield* adapter.readThread(THREAD_ID).pipe(Effect.flip);
            expect(failure).toMatchObject({
              _tag: "ProviderAdapterRequestError",
              method: "get_entries",
            });
          }),
        ),
      { discard: true },
    ),
  );

  it.effect(
    "validates rollback counts and rejects removing more turns than the active branch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entries = [
            {
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: historyUser("one"),
            },
            {
              type: "message",
              id: "assistant-1",
              parentId: "user-1",
              timestamp: "2026-01-01T00:00:01.000Z",
              message: historyAssistant(),
            },
          ];
          const harness = makeRpcHarness({
            onRequest: (request) =>
              Effect.succeed(
                recordString(request, "type") === "get_state"
                  ? successResponse(request, sessionState(1))
                  : successResponse(request, { entries, leafId: "assistant-1" }),
              ),
          });
          const adapter = yield* makeAdapter(harness);
          yield* startSession(adapter);
          yield* takeEvents(adapter, SESSION_EVENTS);

          for (const count of [0, -1, 1.5]) {
            const failure = yield* adapter.rollbackThread(THREAD_ID, count).pipe(Effect.flip);
            expect(failure).toMatchObject({
              _tag: "ProviderAdapterValidationError",
              operation: "rollbackThread",
            });
          }
          const excess = yield* adapter.rollbackThread(THREAD_ID, 2).pipe(Effect.flip);
          expect(excess).toMatchObject({
            _tag: "ProviderAdapterValidationError",
            operation: "rollbackThread",
          });
          expect(
            harness.transports[0]?.requests.some(
              (request) => recordString(request, "type") === "fork",
            ),
          ).toBe(false);
        }),
      ),
  );

  it.effect(
    "forks before the selected active-branch user entry and refreshes session identity",
    () =>
      Effect.forEach(
        [1, 2, 3] as const,
        (numTurns) =>
          Effect.scoped(
            Effect.gen(function* () {
              const allEntries = [
                {
                  type: "message",
                  id: "user-1",
                  parentId: null,
                  timestamp: "2026-01-01T00:00:00.000Z",
                  message: historyUser("one"),
                },
                {
                  type: "message",
                  id: "assistant-1",
                  parentId: "user-1",
                  timestamp: "2026-01-01T00:00:01.000Z",
                  message: historyAssistant(),
                },
                {
                  type: "message",
                  id: "user-2",
                  parentId: "assistant-1",
                  timestamp: "2026-01-01T00:00:02.000Z",
                  message: historyUser("two"),
                },
                {
                  type: "message",
                  id: "assistant-2",
                  parentId: "user-2",
                  timestamp: "2026-01-01T00:00:03.000Z",
                  message: historyAssistant(),
                },
                {
                  type: "message",
                  id: "user-3",
                  parentId: "assistant-2",
                  timestamp: "2026-01-01T00:00:04.000Z",
                  message: historyUser("three"),
                },
                {
                  type: "message",
                  id: "assistant-3",
                  parentId: "user-3",
                  timestamp: "2026-01-01T00:00:05.000Z",
                  message: historyAssistant(),
                },
              ];
              let forkEntryId: string | undefined;
              let entriesRequests = 0;
              const harness = makeRpcHarness({
                onRequest: (request) => {
                  const type = recordString(request, "type");
                  if (type === "get_state") {
                    const postFork = forkEntryId !== undefined;
                    return Effect.succeed(
                      successResponse(
                        request,
                        postFork
                          ? {
                              ...sessionState(9),
                              sessionId: `forked-${numTurns}`,
                              sessionFile: `/private/forked-${numTurns}.jsonl`,
                            }
                          : sessionState(1),
                      ),
                    );
                  }
                  if (type === "get_entries") {
                    entriesRequests += 1;
                    const retainedCount = forkEntryId === undefined ? 6 : (3 - numTurns) * 2;
                    const retained = allEntries.slice(0, retainedCount);
                    return Effect.succeed(
                      successResponse(request, {
                        entries: retained,
                        leafId: retained.at(-1)?.id ?? null,
                      }),
                    );
                  }
                  if (type === "fork") {
                    forkEntryId = recordString(request, "entryId");
                    return Effect.succeed(successResponse(request, { text: "", cancelled: false }));
                  }
                  return Effect.succeed(successResponse(request));
                },
              });
              const adapter = yield* makeAdapter(harness);
              yield* startSession(adapter);
              yield* takeEvents(adapter, SESSION_EVENTS);

              const snapshot = yield* adapter.rollbackThread(THREAD_ID, numTurns);
              const listed = yield* adapter.listSessions();

              expect(forkEntryId).toBe(["user-3", "user-2", "user-1"][numTurns - 1]);
              expect(entriesRequests).toBe(2);
              expect(snapshot.turns).toHaveLength(3 - numTurns);
              expect(snapshot.turns.map((turn) => turn.id)).toEqual(
                ["user-1", "user-2", "user-3"].slice(0, 3 - numTurns),
              );
              expect(listed[0]).toMatchObject({
                threadId: THREAD_ID,
                providerInstanceId: INSTANCE_ID,
                resumeCursor: resumeCursor(`forked-${numTurns}`),
              });
              expect(harness.transports).toHaveLength(1);
            }),
          ),
        { discard: true },
      ),
  );

  it.effect("restarts from the refreshed rollback cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let forked = false;
        const entries = [
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: historyUser("one"),
          },
        ];
        const forkedState = {
          ...sessionState(9),
          sessionId: "forked-restart",
          sessionFile: "/private/forked-restart.jsonl",
        };
        const harness = makeRpcHarness({
          onRequest: (request, transport) => {
            const type = recordString(request, "type");
            if (type === "get_state") {
              const state =
                transport.options.sessionId === "forked-restart" || forked
                  ? forkedState
                  : sessionState(1);
              return Effect.succeed(successResponse(request, state));
            }
            if (type === "get_entries") {
              return Effect.succeed(
                successResponse(
                  request,
                  forked ? { entries: [], leafId: null } : { entries, leafId: "user-1" },
                ),
              );
            }
            if (type === "fork") {
              forked = true;
              return Effect.succeed(successResponse(request, { text: "one", cancelled: false }));
            }
            return Effect.succeed(successResponse(request));
          },
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        yield* adapter.rollbackThread(THREAD_ID, 1);
        const rollbackSession = (yield* adapter.listSessions())[0];
        yield* adapter.stopSession(THREAD_ID);

        const restarted = yield* adapter.startSession({
          threadId: THREAD_ID,
          cwd: "/work/project",
          runtimeMode: "full-access",
          resumeCursor: rollbackSession?.resumeCursor,
        });

        expect(restarted.resumeCursor).toEqual(resumeCursor("forked-restart"));
        expect(containsKey(restarted, "sessionFile")).toBe(false);
        expect(harness.transports).toHaveLength(2);
        expect(harness.transports[1]?.options).toMatchObject({
          cwd: "/work/project",
          sessionId: "forked-restart",
        });
        expect(
          harness.transports[1]?.requests.map((request) => recordString(request, "type")),
        ).toEqual(["get_state"]);
      }),
    ),
  );

  it.effect("routes fork UI and preserves the cursor when fork is cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const forkAccepted = yield* Deferred.make<void>();
        const entries = [
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: historyUser("one"),
          },
        ];
        const harness = makeRpcHarness({
          onRequest: (request, transport) => {
            const type = recordString(request, "type");
            if (type === "get_state")
              return Effect.succeed(successResponse(request, sessionState(1)));
            if (type === "get_entries") {
              return Effect.succeed(successResponse(request, { entries, leafId: "user-1" }));
            }
            if (type === "fork") {
              return offerNative(transport, {
                type: "extension_ui_request",
                id: "fork-confirm",
                method: "confirm",
                title: "Fork?",
                message: "Allow fork",
              }).pipe(
                Effect.andThen(Deferred.await(forkAccepted)),
                Effect.as(successResponse(request, { text: "", cancelled: true })),
              );
            }
            return Effect.succeed(successResponse(request));
          },
          onNotify: (record) =>
            recordString(record, "type") === "extension_ui_response"
              ? Deferred.succeed(forkAccepted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const adapter = yield* makeAdapter(harness);
        const original = yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);

        const rollbackFiber = yield* adapter
          .rollbackThread(THREAD_ID, 1)
          .pipe(Effect.exit, Effect.forkChild);
        const opened = (yield* takeEvents(adapter, 1))[0];
        const concurrent = yield* adapter.rollbackThread(THREAD_ID, 1).pipe(Effect.flip);
        const stopFailure = yield* adapter.stopSession(THREAD_ID).pipe(Effect.flip);
        const replacementFailure = yield* adapter
          .startSession({
            threadId: THREAD_ID,
            cwd: "/work/project",
            runtimeMode: "full-access",
          })
          .pipe(Effect.flip);
        yield* adapter.respondToRequest(
          THREAD_ID,
          ApprovalRequestId.make("fork-confirm"),
          "accept",
        );
        const outcome = yield* Fiber.join(rollbackFiber);
        const listed = yield* adapter.listSessions();

        expect(opened).toMatchObject({ type: "request.opened", requestId: "fork-confirm" });
        expect(concurrent).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          operation: "rollbackThread",
        });
        expect(stopFailure).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          operation: "stopSession",
        });
        expect(replacementFailure).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          operation: "startSession",
        });
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(listed[0]?.resumeCursor).toEqual(original.resumeCursor);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(true);
        expect(harness.transports[0]?.closeCount()).toBe(0);
      }),
    ),
  );

  it.effect("rejects rollback while a turn, pending UI, or compaction owns the session", () =>
    Effect.forEach(
      ["turn", "ui", "compaction"] as const,
      (busyKind) =>
        Effect.scoped(
          Effect.gen(function* () {
            const releaseCompaction = yield* Deferred.make<void>();
            const harness = makeRpcHarness({
              onRequest: (request) =>
                recordString(request, "type") === "compact"
                  ? Deferred.await(releaseCompaction).pipe(
                      Effect.as(
                        successResponse(request, {
                          summary: "done",
                          firstKeptEntryId: "entry",
                          tokensBefore: 1,
                        }),
                      ),
                    )
                  : Effect.succeed(
                      recordString(request, "type") === "get_state"
                        ? successResponse(request, {
                            ...sessionState(1),
                            isStreaming: busyKind === "turn",
                          })
                        : successResponse(request),
                    ),
            });
            const adapter = yield* makeAdapter(harness);
            yield* startSession(adapter);
            yield* takeEvents(adapter, SESSION_EVENTS);
            if (busyKind === "turn") {
              yield* adapter.sendTurn({ threadId: THREAD_ID, input: "busy" });
              yield* takeEvents(adapter, 1);
            } else if (busyKind === "ui") {
              yield* offerNative(harness.transports[0]!, {
                type: "extension_ui_request",
                id: "pending-ui",
                method: "input",
                title: "Input",
              });
              yield* takeEvents(adapter, 1);
            } else if (adapter.compaction?.type === "native") {
              yield* adapter.compaction.start(THREAD_ID).pipe(Effect.forkChild);
              yield* Effect.yieldNow;
            }

            const failure = yield* adapter.rollbackThread(THREAD_ID, 1).pipe(Effect.flip);
            expect(failure).toMatchObject({
              _tag: "ProviderAdapterValidationError",
              operation: "rollbackThread",
            });
            yield* Deferred.succeed(releaseCompaction, undefined);
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("preserves pre-fork state but terminates after post-fork verification failure", () =>
    Effect.forEach(
      ["pre-fork", "post-fork", "post-fork-malformed", "post-fork-mismatch"] as const,
      (failurePoint) =>
        Effect.scoped(
          Effect.gen(function* () {
            let forked = false;
            const entries = [
              {
                type: "message",
                id: "user-1",
                parentId: null,
                timestamp: "2026-01-01T00:00:00.000Z",
                message: historyUser("one"),
              },
            ];
            const harness = makeRpcHarness({
              onRequest: (request) => {
                const type = recordString(request, "type");
                if (type === "get_state") {
                  if (!forked) return Effect.succeed(successResponse(request, sessionState(1)));
                  if (failurePoint === "post-fork") {
                    return Effect.fail(
                      new PiRpcError({
                        reason: "remote-error",
                        method: "get_state",
                        detail: "verification failed",
                      }),
                    );
                  }
                  if (failurePoint === "post-fork-malformed") {
                    return Effect.succeed(
                      successResponse(request, {
                        ...sessionState(2),
                        sessionId: "invalid/session",
                      }),
                    );
                  }
                  return Effect.succeed(
                    successResponse(
                      request,
                      failurePoint === "post-fork-mismatch"
                        ? sessionState(1)
                        : {
                            ...sessionState(2),
                            sessionId: "forked-session",
                            sessionFile: "/private/forked-session.jsonl",
                          },
                    ),
                  );
                }
                if (type === "get_entries") {
                  return failurePoint === "pre-fork"
                    ? Effect.fail(
                        new PiRpcError({
                          reason: "remote-error",
                          method: "get_entries",
                          detail: "history failed",
                        }),
                      )
                    : Effect.succeed(successResponse(request, { entries, leafId: "user-1" }));
                }
                if (type === "fork") {
                  forked = true;
                  return Effect.succeed(successResponse(request, { text: "", cancelled: false }));
                }
                return Effect.succeed(successResponse(request));
              },
            });
            const adapter = yield* makeAdapter(harness);
            const original = yield* startSession(adapter);
            yield* takeEvents(adapter, SESSION_EVENTS);

            const outcome = yield* adapter.rollbackThread(THREAD_ID, 1).pipe(Effect.exit);
            const listed = yield* adapter.listSessions();

            expect(Exit.isFailure(outcome)).toBe(true);
            if (failurePoint === "pre-fork") {
              expect(yield* adapter.hasSession(THREAD_ID)).toBe(true);
              expect(listed[0]?.resumeCursor).toEqual(original.resumeCursor);
              expect(harness.transports[0]?.closeCount()).toBe(0);
            } else {
              expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
              expect(listed).toEqual([]);
              expect(harness.transports[0]?.closeCount()).toBe(1);
            }
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("preserves the session when rollback is interrupted before fork admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entriesRequested = yield* Deferred.make<void>();
        const harness = makeRpcHarness({
          onRequest: (request) => {
            const type = recordString(request, "type");
            if (type === "get_state")
              return Effect.succeed(successResponse(request, sessionState(1)));
            if (type === "get_entries") {
              return Deferred.succeed(entriesRequested, undefined).pipe(
                Effect.andThen(Effect.never),
              );
            }
            return Effect.succeed(successResponse(request));
          },
        });
        const adapter = yield* makeAdapter(harness);
        const original = yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const rollbackFiber = yield* adapter.rollbackThread(THREAD_ID, 1).pipe(Effect.forkChild);
        yield* Deferred.await(entriesRequested);

        yield* Fiber.interrupt(rollbackFiber);

        expect(yield* adapter.hasSession(THREAD_ID)).toBe(true);
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(original.resumeCursor);
        expect(harness.transports[0]?.closeCount()).toBe(0);
      }),
    ),
  );

  it.effect("fails closed when the transport terminates before, during, or after fork", () =>
    Effect.forEach(
      ["before", "during", "after"] as const,
      (phase) =>
        Effect.scoped(
          Effect.gen(function* () {
            let forked = false;
            const entries = [
              {
                type: "message",
                id: "user-1",
                parentId: null,
                timestamp: "2026-01-01T00:00:00.000Z",
                message: historyUser("one"),
              },
            ];
            const terminate = (request: PiRpcCommand, transport: FakeTransport) =>
              transportClosed(transport).pipe(
                Effect.andThen(Effect.yieldNow),
                Effect.andThen(
                  Effect.fail(
                    new PiRpcError({
                      reason: "process-exited",
                      method: recordString(request, "type"),
                      detail: "process exited",
                    }),
                  ),
                ),
              );
            const harness = makeRpcHarness({
              onRequest: (request, transport) => {
                const type = recordString(request, "type");
                if (type === "get_state") {
                  if (forked && phase === "after") return terminate(request, transport);
                  return Effect.succeed(
                    successResponse(
                      request,
                      forked
                        ? { ...sessionState(2), sessionId: "forked-transport-session" }
                        : sessionState(1),
                    ),
                  );
                }
                if (type === "get_entries") {
                  return phase === "before"
                    ? terminate(request, transport)
                    : Effect.succeed(successResponse(request, { entries, leafId: "user-1" }));
                }
                if (type === "fork") {
                  if (phase === "during") return terminate(request, transport);
                  forked = true;
                  return Effect.succeed(
                    successResponse(request, { text: "one", cancelled: false }),
                  );
                }
                return Effect.succeed(successResponse(request));
              },
            });
            const adapter = yield* makeAdapter(harness);
            yield* startSession(adapter);
            yield* takeEvents(adapter, SESSION_EVENTS);

            const outcome = yield* adapter.rollbackThread(THREAD_ID, 1).pipe(Effect.exit);
            yield* Effect.yieldNow;

            expect(Exit.isFailure(outcome)).toBe(true);
            expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
            expect(yield* adapter.listSessions()).toEqual([]);
            expect(harness.transports[0]?.closeCount()).toBe(1);
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("terminates the session when rollback is interrupted after fork admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const forkEntered = yield* Deferred.make<void>();
        const entries = [
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: historyUser("one"),
          },
        ];
        const harness = makeRpcHarness({
          onRequest: (request) => {
            const type = recordString(request, "type");
            if (type === "get_state")
              return Effect.succeed(successResponse(request, sessionState(1)));
            if (type === "get_entries") {
              return Effect.succeed(successResponse(request, { entries, leafId: "user-1" }));
            }
            if (type === "fork") {
              return Deferred.succeed(forkEntered, undefined).pipe(Effect.andThen(Effect.never));
            }
            return Effect.succeed(successResponse(request));
          },
        });
        const adapter = yield* makeAdapter(harness);
        yield* startSession(adapter);
        yield* takeEvents(adapter, SESSION_EVENTS);
        const rollbackFiber = yield* adapter.rollbackThread(THREAD_ID, 1).pipe(Effect.forkChild);
        yield* Deferred.await(forkEntered);

        yield* Fiber.interrupt(rollbackFiber);

        expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
        expect(yield* adapter.listSessions()).toEqual([]);
        expect(harness.transports[0]?.closeCount()).toBe(1);
      }),
    ),
  );

  it.effect(
    "keeps live Pi usage instance-attributed with full model and authoritative totals",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeRpcHarness();
          const adapter = yield* makeAdapter(harness);
          yield* startSession(adapter, THREAD_ID, {
            instanceId: INSTANCE_ID,
            model: "openrouter/meta/large-model",
          });
          yield* takeEvents(adapter, SESSION_EVENTS);
          const { turnId } = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Usage" });
          const started = (yield* takeEvents(adapter, 1))[0];
          const transport = harness.transports[0]!;
          yield* offerNative(transport, {
            type: "message_update",
            usage: usage(100, 8, 20, 5, 0.1),
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" },
          });
          yield* takeEvents(adapter, 1);
          const firstResponse = assistantMessage({
            provider: "openrouter",
            model: "meta/large-model",
            usage: usage(100, 10, 20, 5, 0.2, 3),
          });
          yield* offerNative(transport, { type: "message_end", message: firstResponse });
          yield* offerNative(transport, {
            type: "turn_end",
            message: firstResponse,
            toolResults: [],
          });
          const secondResponse = assistantMessage({
            provider: "openrouter",
            model: "meta/large-model",
            usage: usage(30, 4, 2, 3, 0.3, 2),
          });
          yield* offerNative(transport, { type: "message_end", message: secondResponse });
          yield* offerNative(transport, {
            type: "turn_end",
            message: secondResponse,
            toolResults: [],
          });
          yield* offerNative(transport, { type: "agent_settled" });
          const terminal = (yield* takeEvents(adapter, 1))[0];

          // Live adapter usage remains tied to the exact provider instance. The
          // historical transcript pipeline is intentionally provider-level only.
          expect(started).toMatchObject({
            type: "turn.started",
            providerInstanceId: INSTANCE_ID,
            turnId,
            payload: { model: "openrouter/meta/large-model" },
          });
          expect(terminal).toMatchObject({
            type: "turn.completed",
            providerInstanceId: INSTANCE_ID,
            turnId,
            payload: {
              totalCostUsd: 0.5,
              tokenUsage: {
                usageScope: "main_agent",
                usageStatus: "complete",
                inputTokens: 160,
                outputTokens: 14,
                reasoningTokens: 5,
                cachedInputTokens: 22,
                cacheCreationTokens: 8,
                hasSubagents: false,
              },
              modelUsage: {
                "openrouter/meta/large-model": {
                  inputTokens: 160,
                  outputTokens: 14,
                  reasoningTokens: 5,
                  cachedInputTokens: 22,
                  cacheCreationTokens: 8,
                  totalCostUsd: 0.5,
                },
              },
            },
          });
          expect(terminal).toMatchObject({
            payload: { tokenUsage: { outputTokens: 14, reasoningTokens: 5 } },
          });
        }),
      ),
  );
});
