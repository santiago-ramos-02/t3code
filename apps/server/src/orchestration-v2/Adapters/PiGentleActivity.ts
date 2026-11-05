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
        // Epoch milliseconds; newer gentle-pi only, and null until the task starts or ends.
        startedAt: Schema.optional(Schema.NullOr(Schema.Finite)),
        endedAt: Schema.optional(Schema.NullOr(Schema.Finite)),
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
  // Newer gentle-pi only: its `bash_background` commands and monitors, running or just finished.
  jobs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        kind: Schema.Literals(["command", "monitor"]),
        label: Schema.String,
        status: Schema.Literals(["running", "exited", "stopped", "failed"]),
        exitCode: Schema.optional(Schema.NullOr(Schema.Finite)),
      }),
    ),
  ),
  // Newer gentle-pi only: each provider's latest subscription rate-limit headers. `provider` stays
  // open so a family this server does not know yet never hides the subagents.
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        checkedAt: Schema.Finite,
        headers: Schema.Record(Schema.String, Schema.String),
      }),
    ),
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
  /** The Gentle AI agent it runs as, such as odd-explorer; kept apart from what it was asked. */
  readonly agent: string | null;
  readonly prompt: string;
  readonly status: OrchestrationV2Subagent["status"];
  readonly terminal: boolean;
  /** Runs while the parent goes on, so it can finish after the turn that started it. */
  readonly background: boolean;
  /** The `provider/model` it runs on, when gentle-pi reports a specific one. */
  readonly model: string | null;
  /** Epoch milliseconds from gentle-pi, which survive a restart of T3; null when not sent yet. */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
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
  const agent = summary.agent.trim();
  const title = nonEmpty(summary.label, agent || "Pi subagent");
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
    agent: agent === "" ? null : agent,
    prompt: nonEmpty(summary.prompt, title),
    status: V2_STATUS[summary.status],
    terminal,
    background: summary.mode === "background",
    model: model && model !== "default" ? model : null,
    startedAt: summary.startedAt ?? null,
    endedAt: summary.endedAt ?? null,
    progress,
    result: terminal && finalText.trim() ? boundedText(finalText.trim(), MAX_RESULT_CHARS) : null,
    version: task.thread.version,
    items:
      total === undefined
        ? []
        : items.map((item, index) => ({ number: total - items.length + index, item })),
  };
}

export type GentleJob = NonNullable<(typeof GentleActivitySchema.Type)["jobs"]>[number];
export type GentleProviderLimits = NonNullable<
  (typeof GentleActivitySchema.Type)["limits"]
>[number];

/** The subagents, background jobs and provider limits in one `gentle-agents` widget snapshot, or null when it is not one. */
export function readGentleSnapshot(widgetLines: ReadonlyArray<string> | undefined): {
  readonly tasks: ReadonlyArray<GentleTask>;
  readonly jobs: ReadonlyArray<GentleJob>;
  readonly limits: ReadonlyArray<GentleProviderLimits>;
} | null {
  const line = widgetLines?.length === 1 ? widgetLines[0] : undefined;
  if (line === undefined || line.length > MAX_WIDGET_LINE_CHARS) return null;
  const activity = decodeGentleActivity(line);
  if (Option.isNone(activity)) return null;
  return {
    tasks: activity.value.tasks.map(readTask),
    jobs: activity.value.jobs ?? [],
    limits: activity.value.limits ?? [],
  };
}

/** The subagents in one `gentle-agents` widget snapshot, or null when it is not one. */
export function readGentleActivity(
  widgetLines: ReadonlyArray<string> | undefined,
): ReadonlyArray<GentleTask> | null {
  return readGentleSnapshot(widgetLines)?.tasks ?? null;
}

const ODD_FEATURE_DOCUMENT = /odd\/tasks\/([\w.-]+?)\.md/;
const DEFAULT_WORKFLOW_NAME = "ODD workflow";

/**
 * What to call an ODD workflow: its feature, as the first member prompt to reference
 * `odd/tasks/<feature>.md` names it (`boat-fork-runtime` is "Boat fork runtime"). The request is
 * no name: it opens with whatever the user typed first, such as a path to read.
 */
export function gentleWorkflowName(prompts: ReadonlyArray<string>): string {
  for (const prompt of prompts) {
    const feature = ODD_FEATURE_DOCUMENT.exec(prompt)?.[1]?.replace(/[-_]+/g, " ").trim();
    if (feature) return `${feature.charAt(0).toUpperCase()}${feature.slice(1)}`;
  }
  return DEFAULT_WORKFLOW_NAME;
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
