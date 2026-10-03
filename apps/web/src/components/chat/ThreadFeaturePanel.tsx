import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  gentleOddFeatureRecordCount,
  gentleOddFeatureSummary,
  gentleOddThreadFeaturePaths,
} from "@t3tools/client-runtime/gentle-ai";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
 * Thread details panel section listing the ODD feature documents this thread works on, with
 * where each stands, each opening beside the thread. Renders nothing without any, or without a
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
  const messages = useThreadProjection(threadRef)?.projection?.messages;
  const items = useThreadVisibleTurnItems(threadRef);
  const trail = useMemo(
    () => ({ messages: messages ?? [], records: items ?? [] }),
    [messages, items],
  );
  // An agent touching a document, as when it checks a task off, is when its progress changes.
  const touches = gentleOddFeatureRecordCount(trail);
  const { refresh } = features;
  useEffect(() => {
    if (touches > 0) refresh();
  }, [refresh, touches]);
  const inThread = useMemo(() => {
    const all = features.data?.features ?? [];
    const paths = gentleOddThreadFeaturePaths(
      trail,
      all.map((feature) => feature.path),
    );
    const mine = all.filter((feature) => paths.has(feature.path));
    // The work still going on comes first; Gentle AI lists each part newest first.
    const finished = (feature: (typeof mine)[number]) =>
      feature.tasksTotal > 0 && feature.tasksDone === feature.tasksTotal;
    return [...mine.filter((feature) => !finished(feature)), ...mine.filter(finished)];
  }, [features.data, trail]);
  if (inThread.length === 0) return null;

  return (
    <ThreadDetailsSection headingId="thread-details-feature-heading" title="Feature">
      <ul className="m-0 list-none p-0">
        {inThread.map((feature) => (
          <li
            key={feature.path}
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
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
