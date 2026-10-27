import { assert, describe, it } from "@effect/vitest";
import {
  BoatError,
  CommandId,
  EnvironmentAuthorizationError,
  EventId,
  MessageId,
  ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";

import {
  makeMachineThreads,
  MachineThreadRpcs,
  MACHINE_THREAD_SCOPES,
  type MachineRun,
} from "./machineThreads.ts";

const SANDBOX_ID = "bx_test0001";
const THREAD_ID = ThreadId.make("thread:host:1");
const MESSAGE_ID = MessageId.make("message:host:1");
const OTHER_MESSAGE_ID = MessageId.make("message:host:0");
const PROJECT_ID = ProjectId.make("project:machine");
const REMOTE = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");

const run = (
  id: string,
  userMessageId: MessageId,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId: THREAD_ID,
  ordinal: 1,
  providerInstanceId: REMOTE.instanceId,
  modelSelection: REMOTE,
  providerThreadId: null,
  userMessageId,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

const itemBase = (id: string, runId: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId: THREAD_ID,
  runId: RunId.make(runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  title: null,
  startedAt: NOW,
  completedAt: null,
  updatedAt: NOW,
});

const assistant = (
  id: string,
  runId: string,
  ordinal: number,
  text: string,
  streaming: boolean,
): OrchestrationV2TurnItem => ({
  ...itemBase(id, runId, ordinal),
  type: "assistant_message",
  messageId: MessageId.make(`message:${id}`),
  text,
  streaming,
  status: streaming ? "running" : "completed",
});

const command = (
  id: string,
  runId: string,
  ordinal: number,
  input: string,
): OrchestrationV2TurnItem => ({
  ...itemBase(id, runId, ordinal),
  type: "command_execution",
  input,
  status: "running",
});

const projection = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection => ({
  thread: {
    createdBy: "agent",
    creationSource: "server",
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Task",
    providerInstanceId: REMOTE.instanceId,
    modelSelection: REMOTE,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs,
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems,
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: NOW,
});

const snapshot = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadStreamItem => ({
  kind: "snapshot",
  snapshotSequence: 1,
  projection: projection(runs, turnItems),
});

const runEvent = (
  sequence: number,
  payload: OrchestrationV2Run,
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event:${sequence}`),
    threadId: THREAD_ID,
    occurredAt: NOW,
    type: "run.updated",
    payload,
  },
});

const itemEvent = (
  sequence: number,
  payload: OrchestrationV2TurnItem,
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event:${sequence}`),
    threadId: THREAD_ID,
    occurredAt: NOW,
    type: "turn-item.updated",
    payload,
  },
});

interface Handlers {
  readonly onLaunch?: (input: unknown) => void;
  readonly onCommand?: (input: unknown) => void;
  readonly items?: ReadonlyArray<OrchestrationV2ThreadStreamItem>;
  readonly commandFailure?: "refused" | "unauthorized";
}

/** A machine's RPC server reached the way the host reaches it, minus the socket. */
const machineThreadsWith = (handlers: Handlers) =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(MachineThreadRpcs).pipe(
      Effect.provide(
        Layer.mergeAll(
          MachineThreadRpcs.toLayerHandler(ORCHESTRATION_V2_WS_METHODS.launchThread, (input) =>
            Effect.sync(() => handlers.onLaunch?.(input)).pipe(
              Effect.as({
                threadId: input.threadId ?? THREAD_ID,
                projection: projection([], []),
                resumed: false,
              }),
            ),
          ),
          MachineThreadRpcs.toLayerHandler(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, (input) =>
            handlers.commandFailure === "refused"
              ? Effect.fail(
                  new OrchestrationV2DispatchCommandError({
                    commandId: input.commandId,
                    commandType: input.type,
                    message: "Thread is busy.",
                  }),
                )
              : handlers.commandFailure === "unauthorized"
                ? Effect.fail(
                    new EnvironmentAuthorizationError({
                      message: "Bearer MACHINE-ACCESS-TOKEN lacks a scope.",
                      requiredScope: "orchestration:operate",
                    }),
                  )
                : Effect.sync(() => handlers.onCommand?.(input)).pipe(Effect.as({ sequence: 1 })),
          ),
          MachineThreadRpcs.toLayerHandler(ORCHESTRATION_V2_WS_METHODS.subscribeThread, () =>
            Stream.fromIterable(handlers.items ?? []),
          ),
        ),
      ),
    );
    const requested: Array<{ sandboxId: string; scopes: ReadonlyArray<string> }> = [];
    return {
      requested,
      machines: makeMachineThreads({
        connect: (input) => {
          requested.push({ sandboxId: input.sandboxId, scopes: input.scopes });
          return Effect.succeed(client);
        },
        ensureProject: () => Effect.die("projects are not used by these tests"),
      }),
    };
  });

describe("machineThreads", () => {
  it.effect("connects to the machine with only the scopes it needs", () =>
    Effect.gen(function* () {
      const { machines, requested } = yield* machineThreadsWith({});
      yield* Effect.scoped(machines.connect(SANDBOX_ID));
      assert.deepStrictEqual(requested, [{ sandboxId: SANDBOX_ID, scopes: MACHINE_THREAD_SCOPES }]);
      assert.deepStrictEqual(MACHINE_THREAD_SCOPES, [
        "orchestration:read",
        "orchestration:operate",
      ]);
    }),
  );

  it.effect("sends a message to a thread the machine already has", () =>
    Effect.gen(function* () {
      const commands: Array<unknown> = [];
      const { machines } = yield* machineThreadsWith({
        onCommand: (input) => commands.push(input),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const machine = yield* machines.connect(SANDBOX_ID);
          yield* machine.dispatch({
            threadId: THREAD_ID,
            messageId: MESSAGE_ID,
            text: "Now fix the tests",
            modelSelection: REMOTE,
          });
        }),
      );
      assert.deepStrictEqual(commands, [
        {
          type: "message.dispatch",
          commandId: CommandId.make("boat-message:message:host:1"),
          createdBy: "agent",
          creationSource: "server",
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          text: "Now fix the tests",
          attachments: [],
          modelSelection: REMOTE,
          dispatchMode: { type: "start_immediately" },
        },
      ]);
    }),
  );

  it.effect("stops the thread and the machine's own tasks under it", () =>
    Effect.gen(function* () {
      const commands: Array<unknown> = [];
      const { machines } = yield* machineThreadsWith({
        onCommand: (input) => commands.push(input),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const machine = yield* machines.connect(SANDBOX_ID);
          yield* machine.stop({ threadId: THREAD_ID, requestId: "turn-1" });
        }),
      );
      assert.deepStrictEqual(commands, [
        {
          type: "thread.stop",
          commandId: CommandId.make("boat-stop:turn-1"),
          threadId: THREAD_ID,
          reason: "Stopped from the server that delegated this task.",
        },
      ]);
    }),
  );

  it.effect("reports the machine's own words when it refuses a command", () =>
    Effect.gen(function* () {
      const { machines } = yield* machineThreadsWith({ commandFailure: "refused" });
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const machine = yield* machines.connect(SANDBOX_ID);
          return yield* machine
            .stop({ threadId: THREAD_ID, requestId: "turn-1" })
            .pipe(Effect.flip);
        }),
      );
      assert.deepStrictEqual(error, new BoatError({ detail: "Thread is busy." }));
    }),
  );

  it.effect("follows the run that answers the message, from the snapshot to its end", () =>
    Effect.gen(function* () {
      const earlier = run("run:machine:0", OTHER_MESSAGE_ID, "completed");
      const current = run("run:machine:1", MESSAGE_ID, "running");
      const { machines } = yield* machineThreadsWith({
        items: [
          { kind: "synchronized" },
          snapshot([earlier], [assistant("item:old", "run:machine:0", 1, "Earlier answer", false)]),
          runEvent(2, current),
          itemEvent(3, command("item:cmd", "run:machine:1", 2, "bun test\nsecond line")),
          itemEvent(4, assistant("item:answer", "run:machine:1", 3, "Fixed", true)),
          itemEvent(5, assistant("item:answer", "run:machine:1", 3, "Fixed it", false)),
          runEvent(6, { ...current, status: "completed" }),
          itemEvent(7, assistant("item:after", "run:machine:1", 4, "never seen", false)),
        ],
      });

      const runs = yield* Effect.scoped(
        Effect.gen(function* () {
          const machine = yield* machines.connect(SANDBOX_ID);
          return yield* Stream.runCollect(
            machine.follow({ threadId: THREAD_ID, messageId: MESSAGE_ID }),
          );
        }),
      );

      const answer = (text: string, streaming: boolean) => ({
        kind: "assistant_message" as const,
        id: TurnItemId.make("item:answer"),
        messageId: MessageId.make("message:item:answer"),
        text,
        streaming,
      });
      const ran = {
        kind: "activity" as const,
        id: TurnItemId.make("item:cmd"),
        name: "Command",
        summary: "bun test",
        status: "running" as const,
        needsAttention: false,
      };
      const expected: ReadonlyArray<MachineRun> = [
        { status: "running", items: [], failure: null },
        { status: "running", items: [ran], failure: null },
        { status: "running", items: [ran, answer("Fixed", true)], failure: null },
        { status: "running", items: [ran, answer("Fixed it", false)], failure: null },
        { status: "completed", items: [ran, answer("Fixed it", false)], failure: null },
      ];
      assert.deepStrictEqual([...runs], expected);
    }),
  );

  it.effect("shows a request only the machine can answer, and a failed run's reason", () =>
    Effect.gen(function* () {
      const failed = run("run:machine:1", MESSAGE_ID, "failed");
      const { machines } = yield* machineThreadsWith({
        items: [
          snapshot(
            [failed],
            [
              {
                ...itemBase("item:approval", "run:machine:1", 1),
                type: "approval_request",
                requestId: RuntimeRequestId.make("request:1"),
                requestKind: "command",
                prompt: "Run rm -rf build?",
                status: "waiting",
              },
              {
                ...itemBase("item:error", "run:machine:1", 2),
                type: "error",
                status: "failed",
                failure: {
                  class: "provider_error",
                  message: "The model refused the request.",
                  code: null,
                  retryable: null,
                },
              },
            ],
          ),
        ],
      });

      const [only] = yield* Effect.scoped(
        Effect.gen(function* () {
          const machine = yield* machines.connect(SANDBOX_ID);
          return yield* Stream.runCollect(
            machine.follow({ threadId: THREAD_ID, messageId: MESSAGE_ID }),
          );
        }),
      );

      assert.strictEqual(only?.status, "failed");
      assert.strictEqual(only?.failure, "The model refused the request.");
      assert.deepStrictEqual(only?.items, [
        {
          kind: "activity",
          id: TurnItemId.make("item:approval"),
          name: "Needs attention on the machine",
          summary: "Approval requested: Run rm -rf build?",
          status: "waiting",
          needsAttention: true,
        },
      ]);
    }),
  );

  it.effect("starts a thread from the branch on origin, with the first message", () =>
    Effect.gen(function* () {
      const launches: Array<unknown> = [];
      const { machines } = yield* machineThreadsWith({ onLaunch: (input) => launches.push(input) });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const machine = yield* machines.connect(SANDBOX_ID);
          yield* machine.launch({
            projectId: PROJECT_ID,
            threadId: THREAD_ID,
            title: "Fix the tests",
            modelSelection: REMOTE,
            runtimeMode: "full-access",
            interactionMode: "default",
            baseBranch: "feat/x",
            message: { messageId: MESSAGE_ID, text: "Fix the tests" },
          });
        }),
      );
      assert.deepStrictEqual(launches, [
        {
          commandId: CommandId.make("boat-launch:thread:host:1"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Fix the tests",
          modelSelection: REMOTE,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "worktree", baseRef: "feat/x", startFromOrigin: true },
          initialMessage: { messageId: MESSAGE_ID, text: "Fix the tests", attachments: [] },
        },
      ]);
    }),
  );

  it.effect("does not pass on what the machine says about the connection itself", () =>
    Effect.gen(function* () {
      const { machines } = yield* machineThreadsWith({ commandFailure: "unauthorized" });
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const machine = yield* machines.connect(SANDBOX_ID);
          return yield* machine
            .stop({ threadId: THREAD_ID, requestId: "turn-1" })
            .pipe(Effect.flip);
        }),
      );
      assert.deepStrictEqual(error, new BoatError({ detail: "The Boat machine did not answer." }));
    }),
  );
});
