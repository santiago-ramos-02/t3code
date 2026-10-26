import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { PiGentleTurn } from "@t3tools/provider-pi/server/gentleHooks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makePiGentle } from "./PiGentle.ts";

const DRIVER = ProviderDriverKind.make("pi");
const INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-gentle-test");
const RUN_ID = RunId.make("run:thread-gentle-test:1");
const PROVIDER_THREAD_ID = ProviderThreadId.make("provider-thread-gentle-test");

/** A restart of T3 long after the subagents ran, in epoch milliseconds. */
const NOW = 10_000_000;
const MINUTE = 60_000;

const widget = (...tasks: ReadonlyArray<Record<string, unknown>>) => ({
  type: "extension_ui_request",
  id: "widget",
  method: "setWidget",
  widgetKey: "gentle-agents",
  widgetLines: [
    JSON.stringify({
      schema: "gentle-agents.activity/v1",
      tasks: tasks.map((summary) => ({
        summary: {
          mode: "task",
          prompt: `Do: ${String(summary["label"])}`,
          lastStep: "Working",
          error: null,
          ...summary,
        },
        thread: { version: 0, total: 0, items: [] },
      })),
    }),
  ],
});

const harness = Effect.fnUntraced(function* (request: string) {
  yield* TestClock.setTime(NOW);
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  const appThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: INSTANCE_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
  const providerThread = {
    id: PROVIDER_THREAD_ID,
    driver: DRIVER,
    providerInstanceId: INSTANCE_ID,
    providerSessionId: ProviderSessionId.make("provider-session-gentle-test"),
    appThreadId: THREAD_ID,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  } satisfies OrchestrationV2ProviderThread;
  const turn = {
    turnInput: {
      appThread,
      threadId: THREAD_ID,
      runId: RUN_ID,
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("run-attempt:1"),
      rootNodeId: NodeId.make("node:root"),
      providerThread,
      message: {
        messageId: MessageId.make("message:1"),
        text: request,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: appThread.modelSelection,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    },
    providerTurn: {
      id: ProviderTurnId.make("turn-1"),
      providerThreadId: PROVIDER_THREAD_ID,
      nodeId: NodeId.make("node:turn-1"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  } satisfies PiGentleTurn;
  const gentle = makePiGentle({
    driver: DRIVER,
    instanceId: INSTANCE_ID,
    idAllocator,
    emit: (event) => Effect.sync(() => void events.push(event)),
    threadState: () => ({ providerThread, activeTurn: turn }),
    updateProviderThread: () => Effect.void,
    itemOrdinal: () => 1,
  });
  const show = (...tasks: ReadonlyArray<Record<string, unknown>>) =>
    gentle.onExtensionUiRequest(widget(...tasks));
  const subagents = () =>
    events.flatMap((event) => (event.type === "subagent.updated" ? [event.subagent] : []));
  const workflow = () => {
    const latest = subagents().findLast((subagent) => subagent.workflow !== undefined);
    if (latest === undefined) return assert.fail("no workflow was emitted");
    return latest;
  };
  const member = (title: string): OrchestrationV2Subagent => {
    const latest = subagents().findLast((subagent) => subagent.title === title);
    if (latest === undefined) return assert.fail(`no subagent titled ${title}`);
    return latest;
  };
  return { events, show, workflow, member };
});

const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

describe("makePiGentle", () => {
  it.effect("keeps the times gentle-pi reports when T3 first sees finished subagents", () =>
    Effect.gen(function* () {
      const { show, workflow, member } = yield* harness("Add dark mode");
      yield* show(
        {
          id: "a",
          agent: "gentle-ai-explore",
          label: "Map themes",
          status: "completed",
          startedAt: NOW - 90 * MINUTE,
          endedAt: NOW - 80 * MINUTE,
        },
        {
          id: "b",
          agent: "gentle-ai-worker",
          label: "Write theme",
          status: "completed",
          startedAt: NOW - 70 * MINUTE,
          endedAt: NOW - 60 * MINUTE,
        },
      );
      assert.deepStrictEqual(
        [millis(member("Map themes").startedAt), millis(member("Map themes").completedAt)],
        [NOW - 90 * MINUTE, NOW - 80 * MINUTE],
      );
      assert.deepStrictEqual(
        [millis(member("Write theme").startedAt), millis(member("Write theme").completedAt)],
        [NOW - 70 * MINUTE, NOW - 60 * MINUTE],
      );
      const coordinator = workflow();
      assert.equal(coordinator.status, "completed");
      assert.deepStrictEqual(
        [millis(coordinator.startedAt), millis(coordinator.completedAt)],
        [NOW - 90 * MINUTE, NOW - 60 * MINUTE],
      );
      assert.deepStrictEqual(
        coordinator.workflow?.agents.map((agent) => [agent.startedAt, agent.completedAt]),
        [
          [NOW - 90 * MINUTE, NOW - 80 * MINUTE],
          [NOW - 70 * MINUTE, NOW - 60 * MINUTE],
        ],
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("times a subagent from when T3 saw it when gentle-pi sends no times", () =>
    Effect.gen(function* () {
      const { show, workflow, member } = yield* harness("Add dark mode");
      yield* show({ id: "a", agent: "explorer", label: "Map themes", status: "completed" });
      assert.deepStrictEqual(
        [millis(member("Map themes").startedAt), millis(member("Map themes").completedAt)],
        [NOW, NOW],
      );
      assert.deepStrictEqual(
        [millis(workflow().startedAt), millis(workflow().completedAt)],
        [NOW, NOW],
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("names the workflow after the feature its members' prompts reference", () =>
    Effect.gen(function* () {
      const { events, show, workflow } = yield* harness("Add dark mode\nand keep contrast");
      // The first member names no feature, so the request's first line stands in.
      yield* show({ id: "a", agent: "explorer", label: "Map themes", status: "running" });
      assert.equal(workflow().workflow?.name, "Add dark mode");
      yield* show(
        { id: "a", agent: "explorer", label: "Map themes", status: "running" },
        {
          id: "b",
          agent: "gentle-ai-worker",
          label: "Write theme",
          status: "running",
          prompt: "Spec: odd/tasks/boat-fork-runtime.md, T2, S3-S4",
        },
      );
      const coordinator = workflow();
      assert.equal(coordinator.workflow?.name, "Boat fork runtime");
      assert.equal(coordinator.title, "Boat fork runtime");
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.subagentId === coordinator.id &&
            event.turnItem.title === "Boat fork runtime",
        ),
      );
      // The workflow's thread is retitled too, not only its record.
      const titles = events.flatMap((event) =>
        event.type === "app_thread.created" && event.appThread.id === coordinator.childThreadId
          ? [event.appThread.title]
          : [],
      );
      assert.deepStrictEqual(titles, ["Add dark mode", "Boat fork runtime"]);
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("falls back to a short first line of the request, then to the default name", () =>
    Effect.gen(function* () {
      const long = `${"Refactor the settings panel ".repeat(5).trim()}\nsecond line`;
      const first = yield* harness(long);
      yield* first.show({ id: "a", agent: "explorer", label: "Map", status: "running" });
      const name = first.workflow().workflow?.name ?? "";
      assert.isTrue(name.length <= 72 && name.startsWith("Refactor the settings panel"));
      assert.isFalse(name.includes("second line"));

      const blank = yield* harness("  ");
      yield* blank.show({ id: "a", agent: "explorer", label: "Map", status: "running" });
      assert.equal(blank.workflow().workflow?.name, "ODD workflow");
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("still groups members by their agent's phase", () =>
    Effect.gen(function* () {
      const { show, workflow } = yield* harness("Add dark mode");
      yield* show(
        { id: "a", agent: "gentle-ai-explore", label: "Map themes", status: "running" },
        { id: "b", agent: "gentle-ai-worker", label: "Write theme", status: "running" },
        { id: "c", agent: "gentle-ai-verify", label: "Check theme", status: "queued" },
      );
      const coordinator = workflow();
      assert.deepStrictEqual(coordinator.workflow?.phases, [
        { index: 1, title: "Exploring" },
        { index: 5, title: "Implementing" },
        { index: 6, title: "Checking" },
      ]);
      assert.deepStrictEqual(
        coordinator.workflow?.agents.map((agent) => [agent.label, agent.state, agent.phaseTitle]),
        [
          ["Map themes", "running", "Exploring"],
          ["Write theme", "running", "Implementing"],
          ["Check theme", "queued", "Checking"],
        ],
      );
      assert.equal(coordinator.status, "running");
      assert.equal(coordinator.progress, "0/3 agents done");
    }).pipe(Effect.provide(IdAllocator.layer)),
  );
});
