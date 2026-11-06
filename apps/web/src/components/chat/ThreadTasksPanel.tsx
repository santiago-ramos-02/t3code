import type { EnvironmentId, OrchestrationV2PlanStep, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { findLatestTodoList } from "../../session-logic";
import { useThreadProjection } from "../../state/entities";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { TaskProgressRing } from "./ThreadFeaturePanel";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";

const STEP_ICON = {
  completed: <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-success" />,
  running: <CircleDotIcon aria-hidden className="size-4 shrink-0 text-foreground/80" />,
  pending: <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />,
} satisfies Record<OrchestrationV2PlanStep["status"], ReactNode>;

const STEP_STATUS_LABEL = {
  completed: "Done",
  running: "In progress",
  pending: "Not started",
} satisfies Record<OrchestrationV2PlanStep["status"], string>;

/**
 * Thread details panel section showing the agent's task list as it works through it, from the
 * newest todo list any provider wrote. Renders nothing before the agent writes one.
 */
export function ThreadTasksPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projection = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const todo = findLatestTodoList(projection?.projection ?? null);
  if (todo === null) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-tasks-heading"
      title="Tasks"
      data-thread-tasks-panel
      actions={<TaskProgressRing done={todo.done} total={todo.steps.length} />}
    >
      <ol className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0">
        {todo.steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              "flex items-start rounded-lg py-1",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <span role="img" aria-label={STEP_STATUS_LABEL[step.status]} className="mt-0.5 flex">
              {STEP_ICON[step.status]}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 text-sm break-words",
                step.status === "completed" ? "text-muted-foreground" : "text-foreground/80",
                step.status === "running" && "font-medium",
              )}
            >
              {step.text}
            </span>
          </li>
        ))}
      </ol>
    </ThreadDetailsSection>
  );
}
