import {
  RuntimeTaskId,
  TrimmedNonEmptyString,
  type TaskCompletedPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
  type TurnPlanUpdatedPayload,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { nonEmpty } from "./PiText.ts";

/**
 * gentle-pi publishes subagent activity to RPC hosts as a single JSON line in its
 * `gentle-agents` TUI widget. These limits bound what one update can carry to clients.
 */
export const GENTLE_ACTIVITY_WIDGET_KEY = "gentle-agents";
const MAX_WIDGET_LINE_CHARS = 256 * 1024;
const MAX_RECENT_ITEMS = 40;
const MAX_RECENT_ITEM_CHARS = 2_048;
const MAX_RECENT_TOOL_NAME_CHARS = 120;
const MAX_RECENT_THREAD_CHARS = 24 * 1024;

const GentleActivitySchema = Schema.Struct({
  schema: Schema.Literal("gentle-agents.activity/v1"),
  tasks: Schema.Array(
    Schema.Struct({
      summary: Schema.Struct({
        id: TrimmedNonEmptyString,
        agent: Schema.String,
        label: Schema.String,
        prompt: Schema.String,
        status: Schema.Literals([
          "queued",
          "running",
          "waiting",
          "completed",
          "failed",
          "cancelled",
          "timed_out",
        ]),
        lastStep: Schema.String,
        error: Schema.NullOr(Schema.String),
      }),
      thread: Schema.Struct({
        version: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        items: Schema.Array(
          Schema.Union([
            Schema.Struct({
              kind: Schema.Literals(["text", "thinking", "note"]),
              text: Schema.String,
            }),
            Schema.Struct({
              kind: Schema.Literal("tool"),
              name: Schema.String,
              output: Schema.String,
            }),
          ]),
        ),
      }),
    }),
  ),
});
const decodeGentleActivity = Schema.decodeUnknownOption(
  Schema.fromJsonString(GentleActivitySchema),
);

type GentleTaskStatus = (typeof GentleActivitySchema.Type)["tasks"][number]["summary"]["status"];
type RecentThreadItem = NonNullable<TaskProgressPayload["recentThread"]>[number];

/** What was last published for a subagent, so unchanged widget redraws emit nothing. */
export interface GentleTaskSnapshot {
  readonly status: GentleTaskStatus;
  readonly progress: string;
  readonly lastToolName: string;
  readonly threadVersion: number;
}

export type GentleTaskEvent =
  | { readonly type: "task.started"; readonly payload: TaskStartedPayload }
  | { readonly type: "task.progress"; readonly payload: TaskProgressPayload }
  | { readonly type: "task.completed"; readonly payload: TaskCompletedPayload };

const TERMINAL_STATUSES: ReadonlySet<GentleTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

function liveStatus(status: GentleTaskStatus) {
  return status === "queued" ? "pending" : status === "running" ? "running" : "waiting";
}

function itemChars(item: RecentThreadItem): number {
  return item.kind === "tool" ? item.name.length + item.output.length : item.text.length;
}

/** The newest transcript items that fit the per-update budget, oldest dropped first. */
function recentThread(
  items: (typeof GentleActivitySchema.Type)["tasks"][number]["thread"]["items"],
) {
  const recent: Array<RecentThreadItem> = items.slice(-MAX_RECENT_ITEMS).map((item) =>
    item.kind === "tool"
      ? {
          kind: "tool" as const,
          name: item.name.slice(0, MAX_RECENT_TOOL_NAME_CHARS),
          output: item.output.slice(0, MAX_RECENT_ITEM_CHARS),
        }
      : { kind: item.kind, text: item.text.slice(0, MAX_RECENT_ITEM_CHARS) },
  );
  let total = recent.reduce((sum, item) => sum + itemChars(item), 0);
  while (total > MAX_RECENT_THREAD_CHARS && recent.length > 1) {
    total -= itemChars(recent.shift()!);
  }
  return recent;
}

/**
 * Translates one `gentle-agents` widget update into T3 task events. `published` holds what was
 * last emitted per subagent and is updated in place; unchanged subagents produce no events.
 */
export function gentleActivityEvents(
  widgetLines: ReadonlyArray<string> | undefined,
  published: Map<string, GentleTaskSnapshot>,
): ReadonlyArray<GentleTaskEvent> {
  const line = widgetLines?.length === 1 ? widgetLines[0] : undefined;
  if (line === undefined || line.length > MAX_WIDGET_LINE_CHARS) return [];
  const activity = decodeGentleActivity(line);
  if (Option.isNone(activity)) return [];

  const events: Array<GentleTaskEvent> = [];
  for (const task of activity.value.tasks) {
    const summary = task.summary;
    const title = nonEmpty(summary.label, summary.agent || "Pi subagent");
    const lastItem = task.thread.items.at(-1);
    const output = lastItem?.kind === "tool" ? lastItem.output : lastItem?.text;
    const resultItem = task.thread.items.findLast((item) => item.kind === "text");
    const result = resultItem?.kind === "text" ? resultItem.text : undefined;
    const lastToolName = lastItem?.kind === "tool" ? lastItem.name : "";
    const progress = nonEmpty(
      lastItem?.kind === "text" && output?.trim() ? output : summary.lastStep || output,
      title,
    );
    const identity = {
      taskId: RuntimeTaskId.make(summary.id),
      taskType: "subagent",
      taskSource: "gentle-pi" as const,
      title,
      role: nonEmpty(summary.agent, "Pi subagent"),
    };
    const toolName = lastToolName ? { lastToolName: nonEmpty(lastToolName, "Pi tool") } : {};

    const previous = published.get(summary.id);
    if (previous === undefined) {
      events.push({ type: "task.started", payload: { ...identity, description: title } });
    } else if (
      previous.status === summary.status &&
      previous.progress === progress &&
      previous.lastToolName === lastToolName &&
      previous.threadVersion === task.thread.version
    ) {
      continue;
    }

    const terminal = TERMINAL_STATUSES.has(summary.status);
    const thread = recentThread(task.thread.items);
    // Terminal tasks still publish their final transcript before completing.
    if (thread.length > 0 || !terminal) {
      events.push({
        type: "task.progress",
        payload: {
          ...identity,
          description: title,
          summary: progress,
          ...(thread.length > 0 ? { recentThread: thread } : {}),
          ...toolName,
          ...(terminal ? {} : { status: liveStatus(summary.status) }),
        },
      });
    }
    if (terminal) {
      const finalText = summary.error || result;
      events.push({
        type: "task.completed",
        payload: {
          ...identity,
          status:
            summary.status === "completed"
              ? "completed"
              : summary.status === "cancelled"
                ? "stopped"
                : "failed",
          ...(finalText ? { summary: nonEmpty(finalText, progress) } : {}),
        },
      });
    }
    published.set(summary.id, {
      status: summary.status,
      progress,
      lastToolName,
      threadVersion: task.thread.version,
    });
  }
  return events;
}

/**
 * gentle-pi's `todo` tool returns the complete list in every result's details, so each result
 * replaces the turn's plan, including an empty list after `clear`.
 */
const GENTLE_TODO_TOOL = "todo";
const decodeGentleTodo = Schema.decodeUnknownOption(
  Schema.Struct({
    gentleTodo: Schema.Struct({
      tasks: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          status: Schema.Literals(["pending", "in_progress", "done"]),
        }),
      ),
    }),
  }),
);

/** The plan a gentle-pi todo result sets, or undefined for any other tool result. */
export function gentleTodoPlan(
  toolName: string,
  details: unknown,
): TurnPlanUpdatedPayload | undefined {
  if (toolName !== GENTLE_TODO_TOOL) return undefined;
  const todo = decodeGentleTodo(details);
  if (Option.isNone(todo)) return undefined;
  return {
    plan: todo.value.gentleTodo.tasks.map((task) => ({
      step: nonEmpty(task.title, "Task"),
      status:
        task.status === "done"
          ? "completed"
          : task.status === "in_progress"
            ? "inProgress"
            : "pending",
    })),
  };
}
