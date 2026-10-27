import { assert, describe, it } from "@effect/vitest";
import {
  BoatError,
  CheckpointId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type {
  MachineLaunchInput,
  MachineMessageInput,
  MachineRun,
  MachineRunItem,
  MachineThreads,
} from "../../boat/machineThreads.ts";
import {
  BOAT_DRIVER,
  BoatProviderCapabilitiesV2,
  boatDelegateModelSelection,
  boatInstanceId,
  boatTargetOf,
  makeBoatAdapterV2,
  sandboxIdOfBoatInstance,
} from "./BoatAdapterV2.ts";

const SANDBOX_ID = "bx_test0001";
const INSTANCE_ID = boatInstanceId(SANDBOX_ID);
const REMOTE_URL = "https://github.com/acme/app.git";
const BRANCH = "feat/x";
const REMOTE = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  options: [{ id: "reasoningEffort", value: "high" }],
} satisfies ModelSelection;
const SELECTION = boatDelegateModelSelection({
  sandboxId: SANDBOX_ID,
  remote: REMOTE,
  remoteUrl: REMOTE_URL,
  branch: BRANCH,
});
const HOST_THREAD_ID = ThreadId.make("thread:host:child");
const PROJECT_ID = ProjectId.make("project:host");
const MACHINE_PROJECT_ID = ProjectId.make("project:machine");
const RUNTIME_POLICY = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/host/worktree",
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

type Call =
  | { readonly kind: "ensureProject"; readonly input: unknown }
  | { readonly kind: "connect" }
  | { readonly kind: "launch"; readonly input: MachineLaunchInput }
  | { readonly kind: "dispatch"; readonly input: MachineMessageInput }
  | { readonly kind: "stop"; readonly threadId: ThreadId; readonly requestId: string }
  | { readonly kind: "follow"; readonly threadId: ThreadId; readonly messageId: MessageId };

interface Machine {
  /** What `follow` reports for each turn, in order. */
  readonly follows?: ReadonlyArray<Stream.Stream<MachineRun, BoatError>>;
  readonly ensureProject?: Effect.Effect<never, BoatError>;
  readonly launch?: Effect.Effect<void, BoatError>;
}

const makeMachines = (machine: Machine) => {
  const calls: Array<Call> = [];
  const connections = { opened: 0, closed: 0 };
  let follows = 0;
  const machines: MachineThreads = {
    ensureProject: (input) =>
      Effect.sync(() => calls.push({ kind: "ensureProject", input })).pipe(
        Effect.andThen(
          machine.ensureProject ??
            Effect.succeed({ projectId: MACHINE_PROJECT_ID, workspaceRoot: "/home/user/app" }),
        ),
      ),
    connect: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          calls.push({ kind: "connect" });
          connections.opened++;
        }),
        () => Effect.sync(() => connections.closed++),
      ).pipe(
        Effect.as({
          launch: (input) =>
            Effect.sync(() => calls.push({ kind: "launch", input })).pipe(
              Effect.andThen(machine.launch ?? Effect.void),
            ),
          dispatch: (input) => Effect.sync(() => calls.push({ kind: "dispatch", input })),
          stop: (input) =>
            Effect.sync(() =>
              calls.push({ kind: "stop", threadId: input.threadId, requestId: input.requestId }),
            ),
          follow: (input) => {
            calls.push({ kind: "follow", threadId: input.threadId, messageId: input.messageId });
            return machine.follows?.[follows++] ?? Stream.empty;
          },
        }),
      ),
  };
  return { machines, calls, connections };
};

const makeAppThread = (): OrchestrationV2AppThread => ({
  createdBy: "agent",
  creationSource: "mcp",
  id: HOST_THREAD_ID,
  projectId: PROJECT_ID,
  title: "Fix the flaky test",
  providerInstanceId: INSTANCE_ID,
  modelSelection: SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: HOST_THREAD_ID },
  forkedFrom: null,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const open = (machine: Machine) =>
  Effect.gen(function* () {
    const fake = makeMachines(machine);
    const adapter = makeBoatAdapterV2({ sandboxId: SANDBOX_ID, machines: fake.machines });
    const runtime = yield* adapter.openSession({
      threadId: HOST_THREAD_ID,
      providerSessionId: derive.providerSession({ providerInstanceId: INSTANCE_ID }),
      modelSelection: SELECTION,
      runtimePolicy: RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId: HOST_THREAD_ID,
      title: "Fix the flaky test",
      modelSelection: SELECTION,
      runtimePolicy: RUNTIME_POLICY,
    });
    const turnInput = (
      ordinal: number,
      options: {
        readonly text?: string;
        readonly providerThread?: OrchestrationV2ProviderThread;
        readonly attachments?: ProviderAdapter.ProviderAdapterV2TurnMessage["attachments"];
      } = {},
    ): ProviderAdapter.ProviderAdapterV2TurnInput => {
      const runId = derive.run({ threadId: HOST_THREAD_ID, ordinal });
      const attemptId = derive.runAttempt({ runId, attemptOrdinal: 1 });
      return {
        appThread: makeAppThread(),
        threadId: HOST_THREAD_ID,
        runId,
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId,
        rootNodeId: derive.rootNode({ runId }),
        providerThread: options.providerThread ?? providerThread,
        message: {
          messageId: MessageId.make(`message:host:${ordinal}`),
          text: options.text ?? "Fix the flaky test",
          attachments: options.attachments ?? [],
          createdBy: "agent",
          creationSource: "mcp",
          scheduledTaskId: undefined,
          senderThreadId: undefined,
        },
        modelSelection: SELECTION,
        runtimePolicy: RUNTIME_POLICY,
      };
    };
    return { ...fake, adapter, runtime, providerThread, turnInput };
  });

const untilTerminal = (
  events: Stream.Stream<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >,
) =>
  events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
    Effect.map((collected) => [...collected]),
  );

const ofType = <Type extends ProviderAdapter.ProviderAdapterV2Event["type"]>(
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  type: Type,
) =>
  events.filter(
    (event): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: Type }> =>
      event.type === type,
  );

const answer = (id: string, text: string, streaming: boolean): MachineRunItem => ({
  kind: "assistant_message",
  id: TurnItemId.make(`machine:${id}`),
  messageId: MessageId.make(`machine:message:${id}`),
  text,
  streaming,
});

const command = (
  status: Extract<MachineRunItem, { kind: "activity" }>["status"],
  summary = "bun test",
): MachineRunItem => ({
  kind: "activity",
  id: TurnItemId.make("machine:command"),
  name: "Command",
  summary,
  status,
  needsAttention: false,
});

const run = (
  status: MachineRun["status"],
  items: ReadonlyArray<MachineRunItem> = [],
  failure: string | null = null,
) => ({ status, items, failure }) satisfies MachineRun;

describe("BoatAdapterV2", () => {
  describe("model selection", () => {
    it("names the machine's instance and carries where the work happens", () => {
      assert.strictEqual(SELECTION.instanceId, "boat-bx_test0001");
      assert.strictEqual(SELECTION.model, "gpt-5.4");
      assert.deepStrictEqual(boatTargetOf(SELECTION), {
        remote: REMOTE,
        remoteUrl: REMOTE_URL,
        branch: BRANCH,
      });
      assert.strictEqual(sandboxIdOfBoatInstance(INSTANCE_ID), SANDBOX_ID);
    });

    it("leaves every other selection and instance alone", () => {
      assert.isUndefined(boatTargetOf(REMOTE));
      assert.isUndefined(
        boatTargetOf({ ...REMOTE, options: [{ id: "boat.target", value: "not json" }] }),
      );
      assert.isUndefined(sandboxIdOfBoatInstance(ProviderInstanceId.make("codex")));
      assert.isUndefined(sandboxIdOfBoatInstance(ProviderInstanceId.make("boat-")));
    });
  });

  it.effect("names the machine's thread for the host thread, and keeps one it already has", () =>
    Effect.gen(function* () {
      const { runtime, providerThread } = yield* open({});
      assert.strictEqual(providerThread.providerInstanceId, INSTANCE_ID);
      assert.strictEqual(providerThread.appThreadId, HOST_THREAD_ID);
      assert.strictEqual(providerThread.nativeThreadRef?.nativeId, HOST_THREAD_ID);
      assert.isNull(providerThread.nativeConversationHeadRef);
      const again = yield* runtime.ensureThread({
        threadId: HOST_THREAD_ID,
        modelSelection: SELECTION,
        runtimePolicy: RUNTIME_POLICY,
        existingProviderThread: providerThread,
      });
      assert.strictEqual(again, providerThread);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "starts the first turn by making sure the project exists, then launching the thread",
    () =>
      Effect.gen(function* () {
        const { runtime, turnInput, calls, connections } = yield* open({
          follows: [Stream.make(run("running"), run("completed"))],
        });
        const turn = turnInput(1);
        yield* runtime.startTurn(turn);
        yield* untilTerminal(runtime.events);

        assert.deepStrictEqual(calls, [
          {
            kind: "ensureProject",
            input: { sandboxId: SANDBOX_ID, remoteUrl: REMOTE_URL, branch: BRANCH },
          },
          { kind: "connect" },
          {
            kind: "launch",
            input: {
              projectId: MACHINE_PROJECT_ID,
              threadId: HOST_THREAD_ID,
              title: "Fix the flaky test",
              modelSelection: REMOTE,
              runtimeMode: "full-access",
              interactionMode: "default",
              baseBranch: BRANCH,
              message: { messageId: turn.message.messageId, text: "Fix the flaky test" },
            },
          },
          { kind: "follow", threadId: HOST_THREAD_ID, messageId: turn.message.messageId },
        ]);
        // The connection lasts the turn and no longer.
        assert.deepStrictEqual(connections, { opened: 1, closed: 1 });
      }).pipe(Effect.scoped),
  );

  it.effect("sends a later turn to the same machine thread as a message", () =>
    Effect.gen(function* () {
      const { runtime, turnInput, calls, providerThread } = yield* open({
        follows: [Stream.make(run("completed")), Stream.make(run("completed"))],
      });
      yield* runtime.startTurn(turnInput(1));
      const first = yield* untilTerminal(runtime.events);
      const launched = ofType(first, "provider_thread.updated")[0]?.providerThread;
      assert.isNotNull(launched?.nativeConversationHeadRef);

      calls.length = 0;
      const second = turnInput(2, {
        text: "Now fix the lint",
        providerThread: launched ?? providerThread,
      });
      yield* runtime.startTurn(second);
      yield* untilTerminal(runtime.events);

      assert.deepStrictEqual(calls, [
        { kind: "connect" },
        {
          kind: "dispatch",
          input: {
            threadId: HOST_THREAD_ID,
            messageId: second.message.messageId,
            text: "Now fix the lint",
            modelSelection: REMOTE,
          },
        },
        { kind: "follow", threadId: HOST_THREAD_ID, messageId: second.message.messageId },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("mirrors a machine assistant message once and updates it in place", () =>
    Effect.gen(function* () {
      const { runtime, turnInput } = yield* open({
        follows: [
          Stream.make(
            run("running", [answer("a", "Fix", true)]),
            run("running", [answer("a", "Fix", true)]),
            run("running", [answer("a", "Fixed the", true)]),
            run("completed", [answer("a", "Fixed the test", false)]),
          ),
        ],
      });
      const turn = turnInput(1);
      yield* runtime.startTurn(turn);
      const events = yield* untilTerminal(runtime.events);
      const now = yield* DateTime.now;

      const messageId = derive.messageFromProviderItem({
        driver: BOAT_DRIVER,
        nativeItemId: "machine:message:a",
      });
      const messages = ofType(events, "message.updated").map((event) => event.message);
      // The repeated snapshot changed nothing, so it sent nothing.
      assert.deepStrictEqual(
        messages.map((message) => [message.id, message.text, message.streaming]),
        [
          [messageId, "Fix", true],
          [messageId, "Fixed the", true],
          [messageId, "Fixed the test", false],
        ],
      );
      assert.deepStrictEqual(messages.at(-1), {
        createdBy: "agent",
        creationSource: "provider",
        id: messageId,
        threadId: HOST_THREAD_ID,
        runId: turn.runId,
        nodeId: turn.rootNodeId,
        role: "assistant",
        text: "Fixed the test",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      });

      const items = ofType(events, "turn_item.updated").map((event) => event.turnItem);
      const itemId = derive.turnItemFromProviderItem({
        driver: BOAT_DRIVER,
        nativeItemId: "machine:a",
      });
      assert.deepStrictEqual(
        items.map((item) => [item.id, item.status]),
        [
          [itemId, "running"],
          [itemId, "running"],
          [itemId, "completed"],
        ],
      );
      assert.strictEqual(items.at(-1)?.type, "assistant_message");
      assert.strictEqual(items.at(-1)?.runId, turn.runId);
    }).pipe(Effect.scoped),
  );

  it.effect("shows machine tool activity as simple items and settles them when the run ends", () =>
    Effect.gen(function* () {
      const { runtime, turnInput } = yield* open({
        follows: [
          Stream.make(run("running", [command("running")]), run("completed", [command("running")])),
        ],
      });
      yield* runtime.startTurn(turnInput(1));
      const events = yield* untilTerminal(runtime.events);

      const tools = ofType(events, "turn_item.updated").map((event) => event.turnItem);
      assert.deepStrictEqual(
        tools.map((item) => [item.type, item.status, item.title]),
        [
          ["dynamic_tool", "running", "bun test"],
          ["dynamic_tool", "completed", "bun test"],
        ],
      );
      const [started] = tools;
      assert.strictEqual(started?.type === "dynamic_tool" ? started.toolName : null, "Command");
      assert.deepStrictEqual(started?.type === "dynamic_tool" ? started.input : null, {
        summary: "bun test",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("says so when the machine waits for something only it can give", () =>
    Effect.gen(function* () {
      const { runtime, turnInput } = yield* open({
        follows: [
          Stream.make(
            run("waiting", [
              {
                kind: "activity",
                id: TurnItemId.make("machine:approval"),
                name: "Needs attention on the machine",
                summary: "Approval requested: Run rm -rf build?",
                status: "waiting",
                needsAttention: true,
              },
            ]),
            run("interrupted"),
          ),
        ],
      });
      yield* runtime.startTurn(turnInput(1));
      const events = yield* untilTerminal(runtime.events);

      const [attention] = ofType(events, "turn_item.updated").map((event) => event.turnItem);
      assert.strictEqual(attention?.status, "waiting");
      assert.strictEqual(attention?.title, "Approval requested: Run rm -rf build?");
      assert.strictEqual(
        attention?.type === "dynamic_tool" ? attention.toolName : null,
        "Needs attention on the machine",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("runs a turn from running to completed when the machine's run completes", () =>
    Effect.gen(function* () {
      const { runtime, turnInput } = yield* open({
        follows: [Stream.make(run("running"), run("completed", [answer("a", "Done", false)]))],
      });
      const turn = turnInput(1);
      yield* runtime.startTurn(turn);
      const events = yield* untilTerminal(runtime.events);

      assert.deepStrictEqual(
        events.map((event) =>
          event.type === "provider_turn.updated"
            ? `${event.type}:${event.providerTurn.status}`
            : event.type === "turn.terminal"
              ? `${event.type}:${event.status}`
              : event.type,
        ),
        [
          "provider_turn.updated:running",
          "provider_thread.updated",
          "message.updated",
          "turn_item.updated",
          "provider_turn.updated:completed",
          "turn.terminal:completed",
        ],
      );
      const [terminal] = ofType(events, "turn.terminal");
      assert.deepStrictEqual(terminal, {
        type: "turn.terminal",
        driver: BOAT_DRIVER,
        providerThreadId: turn.providerThread.id,
        providerTurnId: derive.providerTurn({
          driver: BOAT_DRIVER,
          nativeTurnId: String(turn.attemptId),
        }),
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      const [running] = ofType(events, "provider_turn.updated");
      assert.strictEqual(running?.providerTurn.runAttemptId, turn.attemptId);
      assert.strictEqual(running?.providerTurn.nodeId, turn.rootNodeId);
    }).pipe(Effect.scoped),
  );

  it.effect("records the machine thread as launched once it has the message", () =>
    Effect.gen(function* () {
      const { runtime, turnInput } = yield* open({
        follows: [Stream.make(run("completed"))],
      });
      const turn = turnInput(1);
      yield* runtime.startTurn(turn);
      const events = yield* untilTerminal(runtime.events);

      const [updated] = ofType(events, "provider_thread.updated");
      assert.strictEqual(updated?.providerThread.status, "active");
      assert.strictEqual(updated?.providerThread.firstRunOrdinal, 1);
      assert.strictEqual(updated?.providerThread.lastRunOrdinal, 1);
      assert.strictEqual(
        updated?.providerThread.nativeConversationHeadRef?.nativeId,
        turn.message.messageId,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("ends the turn as failed, with the machine's reason, when its run fails", () =>
    Effect.gen(function* () {
      const { runtime, turnInput } = yield* open({
        follows: [Stream.make(run("failed", [], "The model refused the request."))],
      });
      yield* runtime.startTurn(turnInput(1));
      const events = yield* untilTerminal(runtime.events);

      const [terminal] = ofType(events, "turn.terminal");
      assert.strictEqual(terminal?.status, "failed");
      assert.strictEqual(
        terminal?.status === "failed" ? terminal.failure.message : null,
        "The model refused the request.",
      );
      assert.strictEqual(
        ofType(events, "provider_turn.updated").at(-1)?.providerTurn.status,
        "failed",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails the turn with the push-first message when the branch is not on origin", () =>
    Effect.gen(function* () {
      const detail =
        'The branch "feat/x" is not on origin, so the Boat machine cannot work from it. Push it with `git push -u origin feat/x` first, then delegate again.';
      const { runtime, turnInput, calls } = yield* open({
        ensureProject: Effect.fail(new BoatError({ detail })),
      });
      yield* runtime.startTurn(turnInput(1));
      const events = yield* untilTerminal(runtime.events);

      const [terminal] = ofType(events, "turn.terminal");
      assert.strictEqual(terminal?.status === "failed" ? terminal.failure.message : null, detail);
      // The thread never reached the machine, so a retry launches it.
      assert.deepStrictEqual(ofType(events, "provider_thread.updated"), []);
      assert.deepStrictEqual(
        calls.map((call) => call.kind),
        ["ensureProject"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails the turn when the connection ends before the run does", () =>
    Effect.gen(function* () {
      const { runtime, turnInput } = yield* open({
        follows: [Stream.make(run("running", [answer("a", "Working", true)]))],
      });
      yield* runtime.startTurn(turnInput(1));
      const events = yield* untilTerminal(runtime.events);

      const [terminal] = ofType(events, "turn.terminal");
      assert.strictEqual(
        terminal?.status === "failed" ? terminal.failure.message : null,
        "Lost the connection to the Boat machine before the task finished.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails the turn with the machine's error when following it fails", () =>
    Effect.gen(function* () {
      const { runtime, turnInput } = yield* open({
        follows: [Stream.fail(new BoatError({ detail: "The Boat machine did not answer." }))],
      });
      yield* runtime.startTurn(turnInput(1));
      const events = yield* untilTerminal(runtime.events);

      const [terminal] = ofType(events, "turn.terminal");
      assert.strictEqual(
        terminal?.status === "failed" ? terminal.failure.message : null,
        "The Boat machine did not answer.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not send attachments to the machine", () =>
    Effect.gen(function* () {
      const { runtime, turnInput, calls } = yield* open({});
      yield* runtime.startTurn(
        turnInput(1, {
          attachments: [
            {
              type: "image",
              id: "attachment:1",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
          ],
        }),
      );
      const events = yield* untilTerminal(runtime.events);

      const [terminal] = ofType(events, "turn.terminal");
      assert.strictEqual(
        terminal?.status === "failed" ? terminal.failure.message : null,
        "Boat machines cannot receive attachments yet.",
      );
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "stops the machine's run when the turn is interrupted, and ends as the machine reports",
    () =>
      Effect.gen(function* () {
        const stopped = yield* Deferred.make<void>();
        const { runtime, turnInput, calls } = yield* open({
          follows: [
            Stream.make(run("running", [answer("a", "Working", true)])).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.await(stopped)).pipe(
                  Stream.map(() => run("interrupted")),
                ),
              ),
            ),
          ],
        });
        const turn = turnInput(1);
        yield* runtime.startTurn(turn);
        // Wait until the run is under way on the machine.
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "message.updated"),
          Stream.runDrain,
        );

        const providerTurnId = derive.providerTurn({
          driver: BOAT_DRIVER,
          nativeTurnId: String(turn.attemptId),
        });
        yield* runtime.interruptTurn({ providerThread: turn.providerThread, providerTurnId });
        yield* Deferred.succeed(stopped, undefined);
        const rest = yield* untilTerminal(runtime.events);

        assert.deepStrictEqual(
          calls.filter((call) => call.kind === "stop"),
          [{ kind: "stop", threadId: HOST_THREAD_ID, requestId: providerTurnId }],
        );
        assert.strictEqual(ofType(rest, "turn.terminal")[0]?.status, "interrupted");
      }).pipe(Effect.scoped),
  );

  it.effect("ends an interrupted turn here when the machine has not received it yet", () =>
    Effect.gen(function* () {
      const launchStarted = yield* Deferred.make<void>();
      const { runtime, turnInput, calls, connections } = yield* open({
        launch: Deferred.succeed(launchStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const turn = turnInput(1);
      yield* runtime.startTurn(turn);
      // The launch is under way and waits for the machine.
      yield* Deferred.await(launchStarted);

      yield* runtime.interruptTurn({
        providerThread: turn.providerThread,
        providerTurnId: derive.providerTurn({
          driver: BOAT_DRIVER,
          nativeTurnId: String(turn.attemptId),
        }),
      });
      const events = yield* untilTerminal(runtime.events);

      assert.strictEqual(ofType(events, "turn.terminal")[0]?.status, "interrupted");
      assert.deepStrictEqual(ofType(events, "provider_thread.updated"), []);
      assert.deepStrictEqual(
        calls.filter((call) => call.kind === "stop"),
        [],
      );
      assert.deepStrictEqual(connections, { opened: 1, closed: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("offers only what a machine thread can do", () =>
    Effect.gen(function* () {
      const { adapter, runtime, turnInput, providerThread } = yield* open({});
      const capabilities = yield* adapter.getCapabilities();
      assert.strictEqual(capabilities, BoatProviderCapabilitiesV2);
      assert.isFalse(capabilities.turns.supportsActiveSteering);
      assert.isFalse(capabilities.threads.canRollbackThread);
      assert.isFalse(capabilities.threads.canForkThread);
      assert.isFalse(capabilities.approvals.supportsCommandApproval);

      const turn = turnInput(1);
      const steer = yield* runtime
        .steerTurn({
          threadId: HOST_THREAD_ID,
          runId: turn.runId,
          providerThread,
          providerTurnId: derive.providerTurn({ driver: BOAT_DRIVER, nativeTurnId: "x" }),
          message: turn.message,
        })
        .pipe(Effect.flip);
      assert.strictEqual(steer._tag, "ProviderAdapterSteerRunUnsupportedError");
      const fork = yield* runtime
        .forkThread({ sourceProviderThread: providerThread, targetThreadId: HOST_THREAD_ID })
        .pipe(Effect.flip);
      assert.strictEqual(fork._tag, "ProviderAdapterForkThreadError");
      const rollback = yield* runtime
        .rollbackThread({
          providerThread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint:1"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [],
        })
        .pipe(Effect.flip);
      assert.strictEqual(rollback._tag, "ProviderAdapterRollbackThreadError");
    }).pipe(Effect.scoped),
  );
});
