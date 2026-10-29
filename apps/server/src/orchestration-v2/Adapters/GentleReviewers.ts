// @effect-diagnostics nodeBuiltinImport:off - FileSystem.watch registers on a forked fiber, so a write made right after setup can be missed; the directory watch must be registered before its path is handed out.
import * as NodeFS from "node:fs";

import {
  gentleAiEnabled,
  type NodeId,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";

/**
 * gentle-ai runs reviewers inside one `gentle-ai review` shell command, so the provider reports
 * only that command. With this variable set, gentle-ai appends each reviewer's start and finish
 * to the file as NDJSON (see gentle-ai's internal/cli/review_provider_activity.go).
 */
export const GENTLE_REVIEWER_ACTIVITY_ENV = "GENTLE_AI_REVIEWER_ACTIVITY_FILE";

const ReviewerActivity = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("started"),
    id: Schema.String,
    agent: Schema.String,
    model: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("finished"),
    id: Schema.String,
    text: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    id: Schema.String,
    error: Schema.optional(Schema.String),
    cancelled: Schema.optional(Schema.Boolean),
  }),
]);
type ReviewerActivity = typeof ReviewerActivity.Type;
const decodeReviewerActivity = Schema.decodeUnknownOption(Schema.fromJsonString(ReviewerActivity));

// The reviewer's thread: its brief, then its reply.
const CHILD_PROMPT_ORDINAL = 100;
const CHILD_RESULT_ORDINAL = 1_000_000;
export interface GentleReviewerTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
}

export interface GentleReviewersDeps {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  /** The turn whose shell command runs gentle-ai, if any. */
  readonly currentTurn: Effect.Effect<GentleReviewerTurn | null>;
}

/**
 * Opens one session's reviewer report: the environment the provider process needs, and a
 * session-scoped watcher. Off when the session runs without Gentle AI.
 */
export type GentleReviewersHook = (
  input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  deps: GentleReviewersDeps,
) => Effect.Effect<Readonly<Record<string, string>>, never, Scope.Scope>;

/** "review-resilience" reads as "Resilience review", the same label gentle-pi gives it. */
const reviewerLens = (agent: string) => agent.replace(/^review-/, "");
const reviewerTitle = (agent: string) => {
  const lens = reviewerLens(agent);
  return `${lens.charAt(0).toUpperCase()}${lens.slice(1)} review`;
};

interface ReviewerRun {
  readonly turn: GentleReviewerTurn;
  readonly nativeId: string;
  readonly nodeId: NodeId;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: NodeId;
  readonly agent: string;
  readonly model: string | null;
  readonly prompt: string;
  readonly title: string;
  readonly startedAt: DateTime.Utc;
  finished: boolean;
}

/**
 * Turns reviewer activity lines into subagents of the turn that ran them. Untraced: each
 * line already runs inside the session's `GentleReviewers.open` span.
 */
export function makeGentleReviewerReporter(deps: GentleReviewersDeps) {
  const { driver, idAllocator, emit } = deps;
  const ref = (nativeId: string): OrchestrationV2ProviderRef => ({
    driver,
    nativeId,
    strength: "strong",
  });
  const runs = new Map<string, ReviewerRun>();

  const emitState = Effect.fnUntraced(function* (
    run: ReviewerRun,
    status: OrchestrationV2Subagent["status"],
    result: string | null,
    now: DateTime.Utc,
  ) {
    const parent = run.turn.input;
    const completedAt = status === "running" ? null : now;
    const nodeFields = {
      status,
      countsForRun: false,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: run.startedAt,
      completedAt,
    };
    yield* emit({
      type: "node.updated",
      driver,
      node: {
        ...nodeFields,
        id: run.nodeId,
        threadId: parent.threadId,
        runId: parent.runId,
        parentNodeId: parent.rootNodeId,
        rootNodeId: parent.rootNodeId,
        kind: "subagent",
        providerThreadId: parent.providerThread.id,
        providerTurnId: run.turn.providerTurnId,
        nativeItemRef: ref(run.nativeId),
      },
    });
    yield* emit({
      type: "subagent.updated",
      driver,
      subagent: {
        id: run.nodeId,
        threadId: parent.threadId,
        runId: parent.runId,
        parentNodeId: parent.rootNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId: deps.instanceId,
        providerThreadId: parent.providerThread.id,
        childThreadId: run.childThreadId,
        nativeTaskRef: ref(run.nativeId),
        prompt: run.prompt,
        title: run.title,
        agentName: run.agent,
        model: run.model,
        status,
        result,
        startedAt: run.startedAt,
        completedAt,
        updatedAt: now,
      },
    });
    yield* emit({
      type: "node.updated",
      driver,
      node: {
        ...nodeFields,
        id: run.childRootNodeId,
        threadId: run.childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: run.childRootNodeId,
        kind: "root_turn",
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: ref(run.nativeId),
      },
    });
  });

  const emitMessage = Effect.fnUntraced(function* (
    run: ReviewerRun,
    role: "user" | "assistant",
    text: string,
    now: DateTime.Utc,
  ) {
    const nativeItemId = `${run.nativeId}:${role === "user" ? "prompt" : "result"}`;
    const artifacts = makeSubagentConversationArtifacts({
      ...(role === "user" ? { senderThreadId: run.turn.input.threadId } : {}),
      messageId: idAllocator.derive.messageFromProviderItem({ driver, nativeItemId }),
      turnItemId: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
      threadId: run.childThreadId,
      rootNodeId: run.childRootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: ref(nativeItemId),
      role,
      text,
      ordinal: role === "user" ? CHILD_PROMPT_ORDINAL : CHILD_RESULT_ORDINAL,
      now,
    });
    yield* emit({ type: "message.updated", driver, message: artifacts.message });
    yield* emit({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
  });

  const start = Effect.fnUntraced(function* (
    event: Extract<ReviewerActivity, { type: "started" }>,
    now: DateTime.Utc,
  ) {
    if (runs.has(event.id)) return;
    const turn = yield* deps.currentTurn;
    if (turn === null) return;
    const nativeId = `gentle-review:${event.id}`;
    const parent = turn.input;
    const run: ReviewerRun = {
      turn,
      nativeId,
      nodeId: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
      childThreadId: idAllocator.derive.threadFromProviderThread({
        driver,
        nativeThreadId: `${parent.providerThread.id}:${nativeId}`,
      }),
      childRootNodeId: idAllocator.derive.nodeFromProviderItem({
        driver,
        nativeItemId: `${nativeId}:thread-root`,
      }),
      agent: event.agent,
      model: event.model === undefined || event.model === "default" ? null : event.model,
      prompt: `Review the change through the ${reviewerLens(event.agent)} lens.`,
      title: reviewerTitle(event.agent),
      startedAt: now,
      finished: false,
    };
    runs.set(event.id, run);
    yield* emit({
      type: "app_thread.created",
      driver,
      appThread: makeSubagentChildThread({
        parentThread: parent.appThread,
        childThreadId: run.childThreadId,
        parentNodeId: run.nodeId,
        activeProviderThreadId: null,
        providerInstanceId: parent.modelSelection.instanceId,
        modelSelection: parent.modelSelection,
        title: subagentThreadTitle({
          parentTitle: parent.appThread.title,
          prompt: run.prompt,
          title: run.title,
          ordinal: runs.size,
        }),
        agentName: run.agent,
        now,
        createdBy: "agent",
        creationSource: "provider",
      }),
    });
    yield* emitState(run, "running", null, now);
    yield* emitMessage(run, "user", run.prompt, now);
  });

  const finish = Effect.fnUntraced(function* (
    event: Exclude<ReviewerActivity, { type: "started" }>,
    now: DateTime.Utc,
  ) {
    const run = runs.get(event.id);
    if (run === undefined || run.finished) return;
    run.finished = true;
    if (event.type === "finished") {
      const text = event.text ?? "";
      yield* emitState(run, "completed", text, now);
      if (text.length > 0) yield* emitMessage(run, "assistant", text, now);
      return;
    }
    const error = event.error ?? "The reviewer failed.";
    yield* emitState(run, event.cancelled === true ? "cancelled" : "failed", error, now);
    yield* emitMessage(run, "assistant", error, now);
  });

  return {
    /** Applies one NDJSON line; anything that is not a reviewer event is skipped. */
    onLine: Effect.fnUntraced(function* (line: string) {
      const event = decodeReviewerActivity(line);
      if (Option.isNone(event)) return;
      const now = yield* DateTime.now;
      if (event.value.type === "started") yield* start(event.value, now);
      else yield* finish(event.value, now);
    }),
  };
}

/** Builds the hook with the driver's file system, so adapters only supply session state. */
export const makeGentleReviewers = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const open: GentleReviewersHook = Effect.fn("GentleReviewers.open")(function* (input, deps) {
    if (!gentleAiEnabled(input.modelSelection.options)) return {};
    const directory = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-gentle-reviewers-" })
      .pipe(Effect.option);
    if (Option.isNone(directory)) return {};
    const file = path.join(directory.value, "activity.ndjson");
    const created = yield* fileSystem.writeFileString(file, "").pipe(Effect.option);
    if (Option.isNone(created)) return {};
    const reporter = makeGentleReviewerReporter(deps);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let offset = 0;
    let pending = "";
    const readAppended = Effect.gen(function* () {
      const size = yield* fileSystem.stat(file).pipe(Effect.map((info) => Number(info.size)));
      if (size <= offset) return;
      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(file, { flag: "r" });
          yield* handle.seek(BigInt(offset), "start");
          return yield* handle.readAlloc(size - offset);
        }),
      );
      if (Option.isNone(bytes)) return;
      offset += bytes.value.byteLength;
      const lines = (pending + decoder.decode(bytes.value, { stream: true })).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) yield* reporter.onLine(line);
      }
    }).pipe(Effect.ignoreCause({ log: true }));
    // Registered before the file is handed out, so no append is missed. Effect's
    // `FileSystem.watch` registers on a forked fiber, after this hook would return.
    // A sliding slot of one coalesces a burst of appends into one catch-up read.
    const changes = yield* Queue.sliding<void>(1);
    const watcher = yield* Effect.acquireRelease(
      Effect.try(() => {
        const watcher = NodeFS.watch(directory.value, () => Queue.offerUnsafe(changes, undefined));
        watcher.on("error", () => watcher.close());
        return watcher;
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    ).pipe(Effect.option);
    if (Option.isNone(watcher)) return {};
    yield* Queue.take(changes).pipe(
      Effect.andThen(readAppended),
      Effect.forever,
      Effect.forkScoped,
    );
    return { [GENTLE_REVIEWER_ACTIVITY_ENV]: file };
  });
  return open;
});
