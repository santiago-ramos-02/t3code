import {
  TrimmedNonEmptyString,
  type OrchestrationV2PlanStep,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { boundedText, nonEmpty } from "./PiText.ts";

/**
 * gentle-pi publishes subagent activity to RPC hosts as a single JSON line in its
 * `gentle-agents` TUI widget, a full snapshot on every redraw.
 */
export const GENTLE_ACTIVITY_WIDGET_KEY = "gentle-agents";
const MAX_WIDGET_LINE_CHARS = 256 * 1024;
const MAX_PROGRESS_CHARS = 200;
const MAX_RESULT_CHARS = 10_000;

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

/** What was last published for a subagent, so unchanged widget redraws emit nothing. */
export interface GentleTaskSnapshot {
  readonly status: GentleTaskStatus;
  readonly progress: string;
  readonly threadVersion: number;
}

/** One gentle-pi subagent as a V2 subagent. */
export interface GentleSubagentUpdate {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: OrchestrationV2Subagent["status"];
  readonly terminal: boolean;
  readonly progress: string;
  readonly result: string | null;
}

const V2_STATUS = {
  queued: "pending",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  timed_out: "failed",
  cancelled: "cancelled",
} as const satisfies Record<GentleTaskStatus, OrchestrationV2Subagent["status"]>;

const TERMINAL_STATUSES: ReadonlySet<GentleTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Reads one `gentle-agents` widget snapshot. `updates` are the subagents that changed since
 * `published`, which is updated in place; `live` lists every unfinished subagent, the work that
 * keeps the thread running after its turn.
 */
export function gentleActivityUpdates(
  widgetLines: ReadonlyArray<string> | undefined,
  published: Map<string, GentleTaskSnapshot>,
): {
  readonly updates: ReadonlyArray<GentleSubagentUpdate>;
  readonly live: ReadonlyArray<{ readonly id: string; readonly title: string }>;
} {
  const line = widgetLines?.length === 1 ? widgetLines[0] : undefined;
  if (line === undefined || line.length > MAX_WIDGET_LINE_CHARS) return { updates: [], live: [] };
  const activity = decodeGentleActivity(line);
  if (Option.isNone(activity)) return { updates: [], live: [] };

  const updates: Array<GentleSubagentUpdate> = [];
  const live: Array<{ readonly id: string; readonly title: string }> = [];
  for (const task of activity.value.tasks) {
    const summary = task.summary;
    const title = nonEmpty(summary.label, summary.agent || "Pi subagent");
    const terminal = TERMINAL_STATUSES.has(summary.status);
    if (!terminal) live.push({ id: summary.id, title });
    const lastItem = task.thread.items.at(-1);
    const output = lastItem?.kind === "tool" ? lastItem.output : lastItem?.text;
    const progress = nonEmpty(
      lastItem?.kind === "text" && output?.trim() ? output : summary.lastStep || output,
      title,
    ).slice(0, MAX_PROGRESS_CHARS);
    const previous = published.get(summary.id);
    if (
      previous?.status === summary.status &&
      previous.progress === progress &&
      previous.threadVersion === task.thread.version
    ) {
      continue;
    }
    const resultItem = task.thread.items.findLast((item) => item.kind === "text");
    const finalText = summary.error || (resultItem?.kind === "text" ? resultItem.text : "");
    updates.push({
      id: summary.id,
      title,
      prompt: nonEmpty(summary.prompt, title),
      status: V2_STATUS[summary.status],
      terminal,
      progress,
      result: terminal && finalText.trim() ? boundedText(finalText.trim(), MAX_RESULT_CHARS) : null,
    });
    published.set(summary.id, {
      status: summary.status,
      progress,
      threadVersion: task.thread.version,
    });
  }
  return { updates, live };
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

/** The plan steps a gentle-pi todo result sets, or undefined for any other tool result. */
export function gentleTodoSteps(
  toolName: string,
  details: unknown,
): ReadonlyArray<OrchestrationV2PlanStep> | undefined {
  if (toolName !== GENTLE_TODO_TOOL) return undefined;
  const todo = decodeGentleTodo(details);
  if (Option.isNone(todo)) return undefined;
  return todo.value.gentleTodo.tasks.map((task, index) => ({
    id: `todo-${index}`,
    text: nonEmpty(task.title, "Task"),
    status:
      task.status === "done" ? "completed" : task.status === "in_progress" ? "running" : "pending",
  }));
}
