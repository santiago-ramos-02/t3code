import type {
  NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2ProviderRef,
  OrchestrationV2ProviderThread,
  OrchestrationV2Subagent,
  PlanId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PiGentle, PiGentleDeps, PiGentleTurn } from "@t3tools/provider-pi/server/gentleHooks";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  GENTLE_ACTIVITY_WIDGET_KEY,
  gentleTodoSteps,
  readGentleActivity,
  type GentleTask,
  type GentleThreadItem,
} from "./PiGentleActivity.ts";

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
  title: string;
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
 * turn, when gentle-pi wakes the parent agent itself: the adapter hands that run to a
 * continuation run, which this names after the subagent that finished.
 *
 * The Pi adapter lives in @t3tools/provider-pi and calls these hooks (see its gentleHooks.ts),
 * so the fork's change to that upstream file stays a few lines.
 */
export function makePiGentle<Turn extends PiGentleTurn>(deps: PiGentleDeps<Turn>): PiGentle<Turn> {
  const { driver, idAllocator, emit } = deps;
  const ref = (nativeId: string): OrchestrationV2ProviderRef => ({
    driver,
    nativeId,
    strength: "strong",
  });

  const tasks = new Map<string, GentleTaskState<Turn>>();
  /** Unfinished subagents in the latest snapshot with their titles, and the background ones. */
  let live = new Map<string, string>();
  let liveBackground = new Set<string>();
  let lastTurn: Turn | null = null;
  /** A background subagent that finished with no turn running, so gentle-pi is about to wake Pi. */
  let finishedBackground: string | null = null;
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
        title: task.title,
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
    entry.title = task.title;
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
          ...(task.agent === null ? {} : { agentName: task.agent }),
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
        ...(task.agent === null ? {} : { agentName: task.agent }),
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

  /**
   * The provider thread with its gentle-pi entries replaced by the subagents still running.
   * Unfinished subagents keep the thread working through this background roster, which also
   * covers redraws after the turn settles.
   */
  const withRoster = (providerThread: OrchestrationV2ProviderThread) => ({
    ...providerThread,
    pendingBackgroundTasks: [
      ...(providerThread.pendingBackgroundTasks ?? []).filter(
        (task) => !task.taskId.startsWith("gentle:"),
      ),
      ...[...live].map(([id, title]) => ({
        taskId: `gentle:${id}`,
        kind: "subagent" as const,
        description: title,
      })),
    ],
  });

  const onActivity = Effect.fnUntraced(function* (widgetLines: ReadonlyArray<string> | undefined) {
    const state = deps.threadState();
    const snapshot = readGentleActivity(widgetLines);
    if (state === null || snapshot === null) return;
    const now = yield* DateTime.now;
    const wasLive = liveBackground;
    const unfinished = snapshot.filter((task) => !task.terminal);
    live = new Map(unfinished.map((task) => [task.id, task.title]));
    liveBackground = new Set(unfinished.filter((task) => task.background).map((task) => task.id));
    for (const task of snapshot) {
      if (task.terminal && wasLive.has(task.id) && state.activeTurn === null) {
        finishedBackground = task.id;
      }
      yield* emitTask(task, now);
    }
    const current = state.providerThread.pendingBackgroundTasks ?? [];
    const roster = withRoster(state.providerThread).pendingBackgroundTasks ?? [];
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
    onExtensionUiRequest: Effect.fnUntraced(function* (event: Record<string, unknown>) {
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
      live = new Map();
      liveBackground = new Set();
      lastTurn = null;
      finishedBackground = null;
      planIds.clear();
      latestPlan = null;
    },

    /** Names the background subagent whose finish woke Pi, for the continuation run. */
    describeWake: () => {
      if (lastTurn === null) return null;
      // gentle-pi's activity can arrive just after the wake-up it caused, so a background
      // subagent still listed as running counts too.
      const backgroundId = finishedBackground ?? liveBackground.values().next().value;
      const background = backgroundId === undefined ? undefined : tasks.get(backgroundId);
      if (background === undefined) return null;
      finishedBackground = null;
      return {
        detail: WAKE_TEXT,
        notification: backgroundWorkNotification([
          {
            kind: "subagent",
            label: background.title,
            outcome:
              background.status === "failed"
                ? "failed"
                : background.status === "cancelled" || background.status === "interrupted"
                  ? "cancelled"
                  : background.status === "completed"
                    ? "completed"
                    : "unknown",
            childThreadId: background.childThreadId,
          },
        ]),
      };
    },

    /**
     * A turn starts from the provider thread as last saved, which can still list subagents that
     * finished while no run was listening.
     */
    withRoster,

    hasPendingBackgroundWork: Effect.sync(() => live.size > 0),

    hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
      Effect.sync(() =>
        (providerThread.pendingBackgroundTasks ?? []).some((task) =>
          task.taskId.startsWith("gentle:"),
        ),
      ),
  };
}
