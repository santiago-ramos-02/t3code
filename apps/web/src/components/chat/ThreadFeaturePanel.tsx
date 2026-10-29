import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  gentleOddCurrentFeaturePath,
  gentleOddFeatureRecordCount,
  gentleOddMainAgentRecords,
} from "@t3tools/client-runtime/gentle-ai";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { FileTextIcon } from "lucide-react";
import { useEffect } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useGentleAiQuery } from "../settings/gentle-ai/useGentleAi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * Thread details panel section showing the ODD feature document the thread's agent works on now,
 * with where it stands, opening beside the thread. Renders nothing without one, or without a
 * Gentle AI that lists them.
 */
export function ThreadFeaturePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const listed =
    useEnvironmentQuery(
      serverEnvironment.gentleAiStatus({ environmentId: props.environmentId, input: {} }),
    ).data?.oddFeatures === true;
  const features = useGentleAiQuery(
    props.environmentId,
    "odd.features",
    { cwd: props.cwd ?? "" },
    { enabled: listed && props.cwd !== null },
  );
  const projection = useThreadProjection(threadRef)?.projection;
  const items = useThreadVisibleTurnItems(threadRef);
  // An agent touching a document, as when it checks a task off, is when its progress changes.
  const touches = gentleOddFeatureRecordCount({ messages: [], records: items ?? [] });
  const { refresh } = features;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the server's feature query when the agent touches a document
  useEffect(() => {
    if (touches > 0) refresh();
  }, [refresh, touches]);
  // The thread's messages and its main agent's work, oldest first. A subagent's work may read
  // other documents than the one the agent works on.
  const entries: Array<unknown> = [];
  if (projection) {
    const records = gentleOddMainAgentRecords(items ?? [], projection.nodes);
    let next = 0;
    for (const message of projection.messages) {
      const at = DateTime.toEpochMillis(message.createdAt);
      while (next < records.length) {
        const record = records[next];
        if (
          !record ||
          DateTime.toEpochMillis(record.item.startedAt ?? record.item.updatedAt) > at
        ) {
          break;
        }
        entries.push(record);
        next += 1;
      }
      entries.push(message.text);
    }
    entries.push(...records.slice(next));
  }
  const allFeatures = features.data?.features ?? [];
  const currentPath = gentleOddCurrentFeaturePath(
    entries,
    allFeatures.map((entry) => entry.path),
  );
  const feature = allFeatures.find((entry) => entry.path === currentPath) ?? null;
  if (feature === null) return null;

  return (
    <ThreadDetailsSection headingId="thread-details-feature-heading" title="Feature">
      <div
        className={cn(
          "flex items-center rounded-lg py-1.5",
          THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
        )}
      >
        <FileTextIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer truncate text-start text-sm font-medium text-foreground/80 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => useRightPanelStore.getState().openFile(threadRef, feature.path)}
        >
          {feature.title}
        </button>
        {feature.tasksTotal > 0 ? (
          <FeatureProgressRing done={feature.tasksDone} total={feature.tasksTotal} />
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** How many of the feature's tasks are done, as a ring that fills green, with the count on hover. */
function FeatureProgressRing(props: { readonly done: number; readonly total: number }) {
  const label =
    props.done < props.total
      ? `${props.done} of ${props.total} ${props.total === 1 ? "task" : "tasks"} done`
      : props.total === 1
        ? "Task done"
        : `All ${props.total} tasks done`;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={<span role="img" aria-label={label} className="flex size-4 shrink-0" />}
      >
        <svg viewBox="0 0 24 24" aria-hidden className="size-full -rotate-90">
          <circle
            cx="12"
            cy="12"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="3"
            className="stroke-muted-foreground/24"
          />
          {props.done > 0 ? (
            <circle
              cx="12"
              cy="12"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - props.done / props.total)}
              className="stroke-success"
            />
          ) : null}
        </svg>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
