import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { InlineButton } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { MemoryDetailBody, memorySummaryLine, useMemoryDetail } from "./MemoryDetail";

/**
 * One memory beside the thread, opened from its activity log or details panel. Related memories
 * open as tabs next to it; the full Memory page is one link away.
 */
export function MemoryPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly memoryId: number;
  readonly title: string;
}) {
  const { environmentId } = props.threadRef;
  // Relations and the titles of related memories come from the overview.
  const overview = useEnvironmentQuery(
    serverEnvironment.memoryOverview({ environmentId, input: {} }),
  );
  const state = useMemoryDetail(environmentId, props.memoryId, overview.data);
  const observation = state.observation;

  const openMemory = (id: number) =>
    useRightPanelStore.getState().openMemory(props.threadRef, {
      id,
      title: overview.data?.observations.find((entry) => entry.id === id)?.title ?? "Memory",
    });

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-5 p-4">
        <header className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">{observation?.title ?? props.title}</h2>
          {observation ? (
            <p className="text-xs text-muted-foreground">{memorySummaryLine(observation)}</p>
          ) : null}
          <InlineButton
            tone="muted"
            className="self-start text-xs"
            render={<Link to="/memory" search={{ environmentId, memory: props.memoryId }} />}
          >
            Open in Memory
          </InlineButton>
        </header>
        <MemoryDetailBody
          environmentId={environmentId}
          state={state}
          onOpenMemory={openMemory}
          onJudged={overview.refresh}
        />
      </div>
    </ScrollArea>
  );
}
