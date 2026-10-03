import {
  TrimmedNonEmptyString,
  type OrchestrationV2PlanStep,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { boundedText, nonEmpty } from "../../provider/PiText.ts";

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
        // Newer gentle-pi only: whether the parent waits for it, and what it runs on.
        mode: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
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
        // Newer gentle-pi only: items the task ever had, which numbers the kept ones.
        total: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        items: Schema.Array(
          Schema.Union([
            Schema.Struct({
              kind: Schema.Literals(["text", "thinking", "note"]),
              text: Schema.String,
            }),
            Schema.Struct({
              kind: Schema.Literal("tool"),
              name: Schema.String,
              args: Schema.optional(Schema.String),
              running: Schema.optional(Schema.Boolean),
              isError: Schema.optional(Schema.Boolean),
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

type GentleActivityTask = (typeof GentleActivitySchema.Type)["tasks"][number];
type GentleTaskStatus = GentleActivityTask["summary"]["status"];
export type GentleThreadItem = GentleActivityTask["thread"]["items"][number];

/** One gentle-pi subagent, read from a widget snapshot. */
export interface GentleTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: OrchestrationV2Subagent["status"];
  readonly terminal: boolean;
  /** Runs while the parent goes on, so it can finish after the turn that started it. */
  readonly background: boolean;
  /** The `provider/model` it runs on, when gentle-pi reports a specific one. */
  readonly model: string | null;
  readonly progress: string;
  readonly result: string | null;
  /** Changes whenever anything in the task's thread changes. */
  readonly version: number;
  /**
   * The kept thread items with their item number, which stays the same while an item streams
   * in place. Empty for a gentle-pi that does not number them.
   */
  readonly items: ReadonlyArray<{ readonly number: number; readonly item: GentleThreadItem }>;
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

function readTask(task: GentleActivityTask): GentleTask {
  const summary = task.summary;
  const title = nonEmpty(summary.label, summary.agent || "Pi subagent");
  const terminal = TERMINAL_STATUSES.has(summary.status);
  const items = task.thread.items;
  const lastItem = items.at(-1);
  const output = lastItem?.kind === "tool" ? lastItem.output : lastItem?.text;
  const progress = nonEmpty(
    lastItem?.kind === "text" && output?.trim() ? output : summary.lastStep || output,
    title,
  ).slice(0, MAX_PROGRESS_CHARS);
  const resultItem = items.findLast((item) => item.kind === "text");
  const finalText = summary.error || (resultItem?.kind === "text" ? resultItem.text : "");
  const total = task.thread.total;
  const model = summary.model?.trim();
  return {
    id: summary.id,
    title,
    prompt: nonEmpty(summary.prompt, title),
    status: V2_STATUS[summary.status],
    terminal,
    background: summary.mode === "background",
    model: model && model !== "default" ? model : null,
    progress,
    result: terminal && finalText.trim() ? boundedText(finalText.trim(), MAX_RESULT_CHARS) : null,
    version: task.thread.version,
    items:
      total === undefined
        ? []
        : items.map((item, index) => ({ number: total - items.length + index, item })),
  };
}

/** The subagents in one `gentle-agents` widget snapshot, or null when it is not one. */
export function readGentleActivity(
  widgetLines: ReadonlyArray<string> | undefined,
): ReadonlyArray<GentleTask> | null {
  const line = widgetLines?.length === 1 ? widgetLines[0] : undefined;
  if (line === undefined || line.length > MAX_WIDGET_LINE_CHARS) return null;
  const activity = decodeGentleActivity(line);
  return Option.isNone(activity) ? null : activity.value.tasks.map(readTask);
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
