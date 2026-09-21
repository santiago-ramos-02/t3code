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
          resumeCursor: {
            sessionId: "pi-session-1",
            sessionFile: "/private/pi-session-1.jsonl",
          },
        });
        expect(events.map((event) => event.type)).toEqual([
          "session.started",
          "thread.started",
          "session.state.changed",
        ]);
        expect(events.every((event) => event.providerInstanceId === INSTANCE_ID)).toBe(true);
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
        expect(result.resumeCursor).toEqual({
          sessionId: "pi-session-1",
          sessionFile: "/private/pi-session-1.jsonl",
        });
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

  it.effect("accumulates finalized tool-loop usage without duplicate exposure", () =>
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
