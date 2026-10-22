import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  GENTLE_REVIEWER_ACTIVITY_ENV,
  makeGentleReviewerReporter,
  makeGentleReviewers,
  type GentleReviewerTurn,
} from "./GentleReviewers.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claude");
const threadId = ThreadId.make("thread:gentle-reviewers");
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
  approvalPolicy: "never",
});

const makeTurn = (now: DateTime.Utc): GentleReviewerTurn => ({
  input: makeTurnInput({
    threadId,
    instanceId,
    runtimePolicy,
    now,
    providerThread: {
      id: ProviderThreadId.make("provider-thread:gentle-reviewers"),
      driver,
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    },
  }),
  providerTurnId: ProviderTurnId.make("provider-turn:gentle-reviewers"),
});

const line = (event: Record<string, unknown>) => JSON.stringify(event);

const makeHarness = (options: { readonly withTurn: boolean }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const turn = makeTurn(now);
    const reporter = makeGentleReviewerReporter({
      driver,
      instanceId,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      emit: (event) => Effect.sync(() => events.push(event)),
      currentTurn: Effect.succeed(options.withTurn ? turn : null),
    });
    return { events, turn, reporter };
  });

const subagents = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) => (event.type === "subagent.updated" ? [event.subagent] : []));

const messages = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) => (event.type === "message.updated" ? [event.message] : []));

const services = Layer.mergeAll(IdAllocator.layer, NodeServices.layer);

describe("makeGentleReviewerReporter", () => {
  it.effect("shows a finished reviewer as a completed subagent of the turn", () =>
    Effect.gen(function* () {
      const { events, turn, reporter } = yield* makeHarness({ withTurn: true });
      yield* reporter.onLine(
        line({ type: "started", id: "review-1", agent: "review-risk", model: "default" }),
      );
      yield* reporter.onLine(line({ type: "finished", id: "review-1", text: "No findings." }));

      assert.deepEqual(
        events.map((event) => event.type),
        [
          "app_thread.created",
          "node.updated",
          "subagent.updated",
          "node.updated",
          "message.updated",
          "turn_item.updated",
          "node.updated",
          "subagent.updated",
          "node.updated",
          "message.updated",
          "turn_item.updated",
        ],
      );
      const [running, completed] = subagents(events);
      assert.strictEqual(running?.status, "running");
      assert.strictEqual(running?.agentName, "review-risk");
      assert.strictEqual(running?.title, "Risk review");
      assert.strictEqual(running?.model, null);
      assert.strictEqual(running?.parentNodeId, turn.input.rootNodeId);
      assert.strictEqual(running?.runId, turn.input.runId);
      assert.strictEqual(completed?.status, "completed");
      assert.strictEqual(completed?.result, "No findings.");
      assert.deepEqual(
        messages(events).map((message) => [message.role, message.text]),
        [
          ["user", "Review the change through the risk lens."],
          ["assistant", "No findings."],
        ],
      );
      const created = events[0];
      assert.strictEqual(
        created?.type === "app_thread.created" ? created.appThread.id : null,
        running?.childThreadId,
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("maps failed and cancelled reviewers to their subagent status", () =>
    Effect.gen(function* () {
      const { events, reporter } = yield* makeHarness({ withTurn: true });
      yield* reporter.onLine(line({ type: "started", id: "a", agent: "review-refuter" }));
      yield* reporter.onLine(line({ type: "started", id: "b", agent: "review-validator" }));
      yield* reporter.onLine(line({ type: "failed", id: "a", error: "exit 1", cancelled: false }));
      yield* reporter.onLine(
        line({ type: "failed", id: "b", error: "cancelled", cancelled: true }),
      );
      // A second end for a finished run changes nothing.
      yield* reporter.onLine(line({ type: "finished", id: "a", text: "late" }));

      const ended = subagents(events).filter((subagent) => subagent.status !== "running");
      assert.deepEqual(
        ended.map((subagent) => [subagent.agentName, subagent.status, subagent.result]),
        [
          ["review-refuter", "failed", "exit 1"],
          ["review-validator", "cancelled", "cancelled"],
        ],
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("ignores lines it cannot place", () =>
    Effect.gen(function* () {
      const withoutTurn = yield* makeHarness({ withTurn: false });
      yield* withoutTurn.reporter.onLine(line({ type: "started", id: "x", agent: "review-risk" }));
      yield* withoutTurn.reporter.onLine(line({ type: "finished", id: "x", text: "done" }));
      assert.strictEqual(withoutTurn.events.length, 0);

      const withTurn = yield* makeHarness({ withTurn: true });
      yield* withTurn.reporter.onLine("not json");
      yield* withTurn.reporter.onLine(line({ type: "finished", id: "unknown", text: "done" }));
      yield* withTurn.reporter.onLine(line({ type: "other", id: "y" }));
      assert.strictEqual(withTurn.events.length, 0);
    }).pipe(Effect.provide(services)),
  );
});

describe("gentleReviewers", () => {
  const openInput = (gentleAi: boolean): ProviderAdapter.ProviderAdapterV2OpenSessionInput => ({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session:gentle-reviewers"),
    modelSelection: {
      instanceId,
      model: "default",
      options: [{ id: "gentleAi", value: gentleAi }],
    },
    runtimePolicy,
  });

  it.live("reports nothing when the session runs without Gentle AI", () =>
    Effect.gen(function* () {
      const gentleReviewers = yield* makeGentleReviewers;
      const environment = yield* gentleReviewers(openInput(false), {
        driver,
        instanceId,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        emit: () => Effect.void,
        currentTurn: Effect.succeed(null),
      });
      assert.deepEqual(environment, {});
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("turns lines gentle-ai appends to the file into subagents", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const turn = makeTurn(yield* DateTime.now);
      const gentleReviewers = yield* makeGentleReviewers;
      const environment = yield* gentleReviewers(openInput(true), {
        driver,
        instanceId,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        emit: (event) => Queue.offer(emitted, event).pipe(Effect.asVoid),
        currentTurn: Effect.succeed(turn),
      });
      const file = environment[GENTLE_REVIEWER_ACTIVITY_ENV];
      assert.isString(file);
      if (file === undefined) return;

      yield* fileSystem.writeFileString(
        file,
        `${line({ type: "started", id: "r", agent: "review-resilience" })}\n`,
        { flag: "a" },
      );
      let subagent = yield* Queue.take(emitted);
      while (subagent.type !== "subagent.updated") subagent = yield* Queue.take(emitted);
      assert.strictEqual(subagent.subagent.title, "Resilience review");
      assert.strictEqual(subagent.subagent.status, "running");

      yield* fileSystem.writeFileString(
        file,
        `${line({ type: "finished", id: "r", text: "Looks resilient." })}\n`,
        { flag: "a" },
      );
      let finished = yield* Queue.take(emitted);
      while (finished.type !== "subagent.updated") finished = yield* Queue.take(emitted);
      assert.strictEqual(finished.subagent.status, "completed");
      assert.strictEqual(finished.subagent.result, "Looks resilient.");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
