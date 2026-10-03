import type { EnvironmentId, MemoryOverview } from "@t3tools/contracts";

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
