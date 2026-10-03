import type { EnvironmentId, MemoryOverview } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { MemoryDetailBody, memorySummaryLine, useMemoryDetail } from "./MemoryDetail";

/** The Memory page's panel for one memory, opened from the map, lists, and search. */
export function MemoryDetailSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly memoryId: number | null;
  readonly overview: MemoryOverview | null;
  readonly onOpenMemory: (id: number) => void;
  readonly onJudged: () => void;
  readonly onClose: () => void;
}) {
  const state = useMemoryDetail(props.environmentId, props.memoryId, props.overview);
  const { observation, detail } = state;

  return (
    <Sheet
      open={props.memoryId !== null}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle className="me-8">
            {observation?.title ?? (detail.error ? "Memory" : "Loading memory")}
          </SheetTitle>
          <SheetDescription>{observation ? memorySummaryLine(observation) : null}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          <MemoryDetailBody
            environmentId={props.environmentId}
            state={state}
            onOpenMemory={props.onOpenMemory}
            onJudged={props.onJudged}
          />
        </div>
      </SheetPopup>
    </Sheet>
  );
}

/** The same memory beside the map on wide screens, so the map and its marked node stay in view. */
export function MemoryDetailAside(props: {
  readonly environmentId: EnvironmentId;
  readonly memoryId: number;
  readonly overview: MemoryOverview | null;
  readonly onOpenMemory: (id: number) => void;
  readonly onJudged: () => void;
  readonly onClose: () => void;
}) {
  const state = useMemoryDetail(props.environmentId, props.memoryId, props.overview);
  const { observation, detail } = state;
  return (
    <aside
      aria-label={observation?.title ?? "Memory"}
      className="flex w-[28rem] min-w-0 shrink-0 flex-col border-s"
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 p-6">
          <header className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 className="text-base font-semibold">
                {observation?.title ?? (detail.error ? "Memory" : "Loading memory")}
              </h2>
              {observation ? (
                <p className="text-sm text-muted-foreground">{memorySummaryLine(observation)}</p>
              ) : null}
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={props.onClose}>
              <XIcon />
            </Button>
          </header>
          <MemoryDetailBody
            environmentId={props.environmentId}
            state={state}
            onOpenMemory={props.onOpenMemory}
            onJudged={props.onJudged}
          />
        </div>
      </ScrollArea>
    </aside>
  );
}
