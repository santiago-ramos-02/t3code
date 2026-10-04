import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  gentleOddCurrentFeaturePath,
  gentleOddFeatureRecordCount,
  gentleOddFeatureSummary,
  gentleOddMainAgentRecords,
} from "@t3tools/client-runtime/gentle-ai";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { FileTextIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useGentleAiQuery } from "../settings/gentle-ai/useGentleAi";
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
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
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
  useEffect(() => {
    if (touches > 0) refresh();
  }, [refresh, touches]);
  // The thread's messages and its main agent's work, oldest first. A subagent's work may read
  // other documents than the one the agent works on.
  const entries = useMemo(() => {
    if (!projection) return [];
    const records = gentleOddMainAgentRecords(items ?? [], projection.nodes);
    const merged: Array<unknown> = [];
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
        merged.push(record);
        next += 1;
      }
      merged.push(message.text);
    }
    merged.push(...records.slice(next));
    return merged;
  }, [projection, items]);
  const feature = useMemo(() => {
    const all = features.data?.features ?? [];
    const path = gentleOddCurrentFeaturePath(
      entries,
      all.map((entry) => entry.path),
    );
    return all.find((entry) => entry.path === path) ?? null;
  }, [entries, features.data]);
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
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {gentleOddFeatureSummary(feature)}
        </span>
      </div>
    </ThreadDetailsSection>
  );
}
