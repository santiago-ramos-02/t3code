import type {
  NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2ProviderRef,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as IdAllocator from "../IdAllocator.ts";
import type * as ProviderAdapter from "../ProviderAdapter.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "../SubagentProjection.ts";
import {
  GENTLE_ACTIVITY_WIDGET_KEY,
  gentleTodoSteps,
  readGentleActivity,
  type GentleTask,
  type GentleThreadItem,
} from "./PiGentleActivity.ts";
import type { PiRpcRecord } from "./PiRpc.ts";

/** The parts of the Pi adapter's turn that gentle-pi activity is attributed to. */
export interface PiGentleTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
}

export interface PiGentleThreadState<Turn extends PiGentleTurn> {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: Turn | null;
}

export interface PiGentleDeps<Turn extends PiGentleTurn> {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly threadState: () => PiGentleThreadState<Turn> | null;
  readonly updateProviderThread: (
    state: PiGentleThreadState<Turn>,
    patch: Partial<OrchestrationV2ProviderThread>,
  ) => Effect.Effect<void>;
  /** The item's ordinal in its turn, the same for every update of one item. */
  readonly itemOrdinal: (turn: Turn, nativeItemId: string) => number;
  /** Starts a run for a wake-up gentle-pi started on its own; without it, wake-ups stay refused. */
  readonly continuationRequests:
    | { readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void> }
    | undefined;
}

// Child thread items sort after the prompt, by their gentle-pi item number.
const CHILD_PROMPT_ORDINAL = 100;
const CHILD_FIRST_ITEM_ORDINAL = 101;
const CHILD_RESULT_ORDINAL = 1_000_000;
const WAKE_TEXT = "A background subagent finished.";

const decodeToolArgs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
/** One thread item as text, to tell whether it changed since it was last emitted. */
const fingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Tool arguments arrive JSON-encoded and may be cut short, which leaves them as plain text. */
function toolInput(args: string | undefined): unknown {
  if (args === undefined || args.length === 0) return {};
  return Option.getOrElse(decodeToolArgs(args), () => ({ arguments: args }));
}

interface GentleTaskState<Turn extends PiGentleTurn> {
  /** The turn that first saw the subagent, which keeps its card. */
  readonly turn: Turn;
  readonly startedAt: DateTime.Utc;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: NodeId;
  status: OrchestrationV2Subagent["status"] | null;
  completedAt: DateTime.Utc | null;
  version: number;
  progress: string;
  /** What was last emitted for each thread item, by item number. */
  readonly items: Map<number, string>;
  resultShown: boolean;
}

/**
 * gentle-pi's part of the Pi adapter. gentle-pi runs subagents as their own Pi processes and
 * reports them through its `gentle-agents` widget; each one becomes a native subagent with a
 * read-only child thread, like Claude's and Codex's. Background ones can finish after their
 * turn, when gentle-pi wakes the parent agent itself: that run is held and handed to a
 * continuation run instead of being refused as invisible work.
 *
 * Kept out of PiAdapterV2.ts, which calls these hooks, so the fork's change to that upstream
 * file stays a few lines.
 */
export function makePiGentle<Turn extends PiGentleTurn>(deps: PiGentleDeps<Turn>) {
  const { driver, idAllocator, emit } = deps;
  const ref = (nativeId: string): OrchestrationV2ProviderRef => ({
    driver,
    nativeId,
    strength: "strong",
  });

  const tasks = new Map<string, GentleTaskState<Turn>>();
  /** Unfinished subagents in the latest snapshot, and which of them run in the background. */
  let live = new Set<string>();
  let liveBackground = new Set<string>();
  let lastTurn: Turn | null = null;
  /** A background subagent that finished with no turn running, so gentle-pi is about to wake Pi. */
  let finishedBackground: string | null = null;
  /** Events of a wake-up run, held until a turn takes it over. */
  let wake: Array<PiRpcRecord> | null = null;
  const planIds = new Map<string, PlanId>();
  let latestPlan: OrchestrationV2PlanArtifact | null = null;

  const itemFields = (
    turn: Turn,
    nativeItemId: string,
    startedAt: DateTime.Utc,
    updatedAt: DateTime.Utc,
  ) => ({
    id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
    threadId: turn.turnInput.threadId,
    runId: turn.turnInput.runId,
    nodeId: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId }),
    providerThreadId: turn.turnInput.providerThread.id,
    providerTurnId: turn.providerTurn.id,
    nativeItemRef: ref(nativeItemId),
    parentItemId: null,
    ordinal: deps.itemOrdinal(turn, nativeItemId),
    startedAt,
    updatedAt,
  });

  const emitNode = (node: OrchestrationV2ExecutionNode) =>
    emit({ type: "node.updated", driver, node });

  // ── subagents ──────────────────────────────────────────

  const emitChildItem = Effect.fnUntraced(function* (
    entry: GentleTaskState<Turn>,
    nativeTaskId: string,
    number: number,
    item: GentleThreadItem,
    now: DateTime.Utc,
  ) {
    const nativeItemId = `${nativeTaskId}:item:${number}`;
    const turnItemId = idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId });
    const ordinal = CHILD_FIRST_ITEM_ORDINAL + number;
    if (item.kind === "text") {
      const artifacts = makeSubagentConversationArtifacts({
        messageId: idAllocator.derive.messageFromProviderItem({ driver, nativeItemId }),
        turnItemId,
        threadId: entry.childThreadId,
        rootNodeId: entry.childRootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: ref(nativeItemId),
        role: "assistant",
        text: item.text,
        ordinal,
        now,
      });
      yield* emit({ type: "message.updated", driver, message: artifacts.message });
      yield* emit({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
      return;
    }
    const base = {
      id: turnItemId,
      threadId: entry.childThreadId,
      runId: null,
      nodeId: entry.childRootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: ref(nativeItemId),
      parentItemId: null,
      ordinal,
      startedAt: now,
      updatedAt: now,
    };
    if (item.kind === "tool") {
      const running = item.running === true;
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...base,
          status: running ? "running" : item.isError === true ? "failed" : "completed",
          title: item.name,
          completedAt: running ? null : now,
          type: "dynamic_tool",
          toolName: item.name.trim().length > 0 ? item.name : null,
          input: toolInput(item.args),
          ...(item.output.length > 0 ? { output: item.output } : {}),
        },
      });
      return;
    }
    const finished = { ...base, status: "completed" as const, title: null, completedAt: now };
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem:
        item.kind === "thinking"
          ? { ...finished, type: "reasoning", text: item.text, streaming: false }
          : { ...finished, type: "system_notice", message: item.text },
    });
  });

  const emitTask = Effect.fnUntraced(function* (task: GentleTask, now: DateTime.Utc) {
    const state = deps.threadState();
    if (state === null) return;
    const nativeTaskId = `gentle:${task.id}`;
    const subagentId = idAllocator.derive.nodeFromProviderItem({
      driver,
      nativeItemId: nativeTaskId,
    });
    let entry = tasks.get(task.id);
    const isNew = entry === undefined;
    if (entry === undefined) {
      const turn = state.activeTurn ?? lastTurn;
      if (turn === null) return;
      entry = {
        turn,
        startedAt: now,
        childThreadId: idAllocator.derive.threadFromProviderThread({
          driver,
          nativeThreadId: `${turn.turnInput.providerThread.id}:${nativeTaskId}`,
        }),
        childRootNodeId: idAllocator.derive.nodeFromProviderItem({
          driver,
          nativeItemId: `${nativeTaskId}:thread-root`,
        }),
        status: null,
        completedAt: null,
        version: -1,
        progress: "",
        items: new Map(),
        resultShown: false,
      };
      tasks.set(task.id, entry);
    } else if (
      entry.status === task.status &&
      entry.version === task.version &&
      entry.progress === task.progress
    ) {
      return;
    }
    const { turn } = entry;
    const lifecycleChanged = entry.status !== task.status;
    entry.status = task.status;
    entry.version = task.version;
    entry.progress = task.progress;
    entry.completedAt = task.terminal ? (entry.completedAt ?? now) : null;
    const { startedAt, completedAt, childThreadId, childRootNodeId } = entry;

    if (isNew) {
      const parent = turn.turnInput;
      yield* emit({
        type: "app_thread.created",
        driver,
        appThread: makeSubagentChildThread({
          parentThread: parent.appThread,
          childThreadId,
          parentNodeId: subagentId,
          activeProviderThreadId: null,
          providerInstanceId: deps.instanceId,
          modelSelection:
            task.model === null
              ? parent.modelSelection
              : { instanceId: deps.instanceId, model: task.model },
          title: subagentThreadTitle({
            parentTitle: parent.appThread.title,
            prompt: task.prompt,
            title: task.title,
            ordinal: tasks.size,
          }),
          now,
          createdBy: "agent",
          creationSource: "provider",
        }),
      });
      const promptItemId = `${nativeTaskId}:prompt`;
      const prompt = makeSubagentConversationArtifacts({
        senderThreadId: parent.threadId,
        messageId: idAllocator.derive.messageFromProviderItem({
          driver,
          nativeItemId: promptItemId,
        }),
        turnItemId: idAllocator.derive.turnItemFromProviderItem({
          driver,
          nativeItemId: promptItemId,
        }),
        threadId: childThreadId,
        rootNodeId: childRootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: ref(promptItemId),
        role: "user",
        text: task.prompt,
        ordinal: CHILD_PROMPT_ORDINAL,
        now,
      });
      yield* emit({ type: "message.updated", driver, message: prompt.message });
      yield* emit({ type: "turn_item.updated", driver, turnItem: prompt.turnItem });
    }

    if (lifecycleChanged) {
      const nodeFields = {
        status: task.status,
        countsForRun: false,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      };
      yield* emitNode({
        ...nodeFields,
        id: subagentId,
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        parentNodeId: turn.turnInput.rootNodeId,
        rootNodeId: turn.turnInput.rootNodeId,
        kind: "subagent",
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(nativeTaskId),
      });
      yield* emitNode({
        ...nodeFields,
        id: childRootNodeId,
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: childRootNodeId,
        kind: "root_turn",
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: ref(nativeTaskId),
      });
    }

    const progress = task.terminal ? {} : { progress: task.progress };
    yield* emit({
      type: "subagent.updated",
      driver,
      subagent: {
        id: subagentId,
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        parentNodeId: turn.turnInput.rootNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId: deps.instanceId,
        providerThreadId: turn.turnInput.providerThread.id,
        childThreadId,
        nativeTaskRef: ref(nativeTaskId),
        prompt: task.prompt,
        title: task.title,
        model: task.model,
        status: task.status,
        ...progress,
        result: task.result,
        startedAt,
        completedAt,
        updatedAt: now,
      },
    });
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...itemFields(turn, nativeTaskId, startedAt, now),
        status: task.status,
        title: task.title,
        completedAt,
        type: "subagent",
        subagentId,
        origin: "provider_native",
        driver,
        providerInstanceId: deps.instanceId,
        childThreadId,
        prompt: task.prompt,
        ...progress,
        result: task.result,
      },
    });

    for (const { number, item } of task.items) {
      const encoded = fingerprint(item);
      if (entry.items.get(number) === encoded) continue;
      entry.items.set(number, encoded);
      yield* emitChildItem(entry, nativeTaskId, number, item, now);
    }
    // A finished subagent's answer is its last reply, already in its thread. A failure's
    // reason, or a result from a gentle-pi that sends no thread items, is added once.
    const resultMissing = task.status !== "completed" || task.items.length === 0;
    if (task.terminal && task.result !== null && resultMissing && !entry.resultShown) {
      entry.resultShown = true;
      const resultItemId = `${nativeTaskId}:result`;
      const result = makeSubagentConversationArtifacts({
        messageId: idAllocator.derive.messageFromProviderItem({
          driver,
          nativeItemId: resultItemId,
        }),
        turnItemId: idAllocator.derive.turnItemFromProviderItem({
          driver,
          nativeItemId: resultItemId,
        }),
        threadId: childThreadId,
        rootNodeId: childRootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: ref(resultItemId),
        role: "assistant",
        text: task.result,
        ordinal: CHILD_RESULT_ORDINAL,
        now,
      });
      yield* emit({ type: "message.updated", driver, message: result.message });
      yield* emit({ type: "turn_item.updated", driver, turnItem: result.turnItem });
    }
  });

  const onActivity = Effect.fnUntraced(function* (widgetLines: ReadonlyArray<string> | undefined) {
    const state = deps.threadState();
    const snapshot = readGentleActivity(widgetLines);
    if (state === null || snapshot === null) return;
    const now = yield* DateTime.now;
    const wasLive = liveBackground;
    const unfinished = snapshot.filter((task) => !task.terminal);
    live = new Set(unfinished.map((task) => task.id));
    liveBackground = new Set(unfinished.filter((task) => task.background).map((task) => task.id));
    for (const task of snapshot) {
      if (task.terminal && wasLive.has(task.id) && state.activeTurn === null) {
        finishedBackground = task.id;
      }
      yield* emitTask(task, now);
    }
    // Unfinished subagents keep the thread working through the provider thread's background
    // roster, which also covers redraws after the turn settles.
    const others = (state.providerThread.pendingBackgroundTasks ?? []).filter(
      (task) => !task.taskId.startsWith("gentle:"),
    );
    const roster = [
      ...others,
      ...snapshot
        .filter((task) => !task.terminal)
        .map((task) => ({
          taskId: `gentle:${task.id}`,
          kind: "subagent" as const,
          description: task.title,
        })),
    ];
    const current = state.providerThread.pendingBackgroundTasks ?? [];
    if (
      roster.length !== current.length ||
      roster.some((task, index) => task.taskId !== current[index]?.taskId)
    ) {
      yield* deps.updateProviderThread(state, { pendingBackgroundTasks: roster });
    }
  });

  // ── todo list ──────────────────────────────────────────

  // gentle-pi's todo tool returns the whole list each time; it is the turn's task list.
  const emitTodo = Effect.fnUntraced(function* (
    turn: Turn,
    steps: ReadonlyArray<OrchestrationV2PlanStep>,
  ) {
    const updatedAt = yield* DateTime.now;
    const nativeItemId = `gentle-todo:${turn.providerTurn.id}`;
    const planId =
      planIds.get(nativeItemId) ??
      (yield* idAllocator.allocate.plan({
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        driver,
      }));
    planIds.set(nativeItemId, planId);
    const nodeId = idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId });
    const plan: OrchestrationV2PlanArtifact = {
      id: planId,
      threadId: turn.turnInput.threadId,
      runId: turn.turnInput.runId,
      nodeId,
      kind: "todo_list",
      status: steps.every((step) => step.status === "completed") ? "completed" : "active",
      steps: [...steps],
    };
    const previous = latestPlan;
    if (previous !== null && previous.id !== plan.id && previous.status !== "completed") {
      yield* emit({ type: "plan.updated", driver, plan: { ...previous, status: "superseded" } });
    }
    latestPlan = plan;
    yield* emitNode({
      id: nodeId,
      threadId: turn.turnInput.threadId,
      runId: turn.turnInput.runId,
      parentNodeId: turn.turnInput.rootNodeId,
      rootNodeId: turn.turnInput.rootNodeId,
      kind: "todo_list",
      status: "completed",
      countsForRun: false,
      providerThreadId: turn.turnInput.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: ref(nativeItemId),
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: updatedAt,
      completedAt: updatedAt,
    });
    yield* emit({ type: "plan.updated", driver, plan });
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...itemFields(turn, nativeItemId, updatedAt, updatedAt),
        status: "completed",
        title: null,
        completedAt: updatedAt,
        type: "todo_list",
        planId,
        steps: [...steps],
      },
    });
  });

  return {
    /** Handles gentle-pi's activity widget; false for every other UI request. */
    onExtensionUiRequest: Effect.fnUntraced(function* (event: PiRpcRecord) {
      if (event["method"] !== "setWidget" || event["widgetKey"] !== GENTLE_ACTIVITY_WIDGET_KEY) {
        return false;
      }
      const lines = event["widgetLines"];
      yield* onActivity(
        Array.isArray(lines)
          ? lines.filter((line): line is string => typeof line === "string")
          : undefined,
      );
      return true;
    }),

    onToolResult: (turn: Turn, toolName: string, details: unknown, completed: boolean) => {
      const steps = completed ? gentleTodoSteps(toolName, details) : undefined;
      return steps === undefined ? Effect.void : emitTodo(turn, steps);
    },

    /** Subagents that change after their turn settles stay on the last turn. */
    onTurnFinalized: (turn: Turn) => {
      lastTurn = turn;
    },

    /** Pi's native session changed, so nothing seen so far belongs to it. */
    reset: () => {
      tasks.clear();
      live = new Set();
      liveBackground = new Set();
      lastTurn = null;
      finishedBackground = null;
      wake = null;
      planIds.clear();
      latestPlan = null;
    },

    /**
     * Pi started a run outside a T3 turn. When a background subagent is the likely reason, the
     * run is held and a continuation run is requested to take it over; false leaves the
     * adapter's refusal in place.
     */
    adoptUnsolicitedRun: Effect.fnUntraced(function* (event: PiRpcRecord) {
      const state = deps.threadState();
      if (deps.continuationRequests === undefined || state === null || lastTurn === null) {
        return false;
      }
      if (wake !== null) {
        wake.push(event);
        return true;
      }
      // gentle-pi's activity can arrive just after the wake-up it caused, so a background
      // subagent still listed as running counts too.
      const backgroundId = finishedBackground ?? liveBackground.values().next().value;
      const background = backgroundId === undefined ? undefined : tasks.get(backgroundId);
      if (background === undefined) return false;
      wake = [event];
      yield* deps.continuationRequests.offer({
        threadId: lastTurn.turnInput.threadId,
        providerThreadId: state.providerThread.id,
        driver,
        detail: WAKE_TEXT,
        notification: {
          source: { kind: "subagent", childThreadId: background.childThreadId },
          outcome: "completed",
          summary: "Background subagent finished",
        },
        delivery: "adapter_buffered",
      });
      return true;
    }),

    /** Holds an event of a wake-up run until a turn takes it over. */
    holdWakeEvent: (event: PiRpcRecord) => {
      if (wake === null || deps.threadState()?.activeTurn != null) return false;
      // Dialogs and widgets work without a turn, and the user may need to answer one first.
      if (event["type"] === "extension_ui_request" || event["type"] === "extension_error") {
        return false;
      }
      wake.push(event);
      return true;
    },

    /** The held wake-up run's events, for the turn starting now to replay. */
    takeWake: () => {
      const events = wake;
      wake = null;
      finishedBackground = null;
      return events;
    },

    hasPendingBackgroundWork: Effect.sync(() => live.size > 0 || wake !== null),

    hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
      Effect.sync(
        () =>
          wake !== null ||
          (providerThread.pendingBackgroundTasks ?? []).some((task) =>
            task.taskId.startsWith("gentle:"),
          ),
      ),
  };
}
