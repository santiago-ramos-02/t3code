import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { BrainIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useThreadVisibleTurnItems } from "../../state/entities";
import { useMemoryEnvironments } from "../../state/environments";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { InlineButton } from "../ui/button";
import { threadSavedMemories } from "./threadMemories";

const VISIBLE = 5;

/**
 * Thread details panel section listing the memories agents saved in this thread, each opening on
 * the Memory page. Renders nothing when the thread saved none.
 */
export function ThreadMemoryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const items = useThreadVisibleTurnItems({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const reads = useMemoryEnvironments().some(
    (environment) => environment.environmentId === props.environmentId,
  );
  const memories = useMemo(() => threadSavedMemories(items), [items]);
  const [showAll, setShowAll] = useState(false);
  if (memories.length === 0) return null;
  const shown = showAll ? memories : memories.slice(0, VISIBLE);

  return (
    <ThreadDetailsSection headingId="thread-details-memory-heading" title="Memory">
      <ul className="m-0 list-none p-0">
        {shown.map((memory) => (
          <li
            key={memory.key}
            className={cn(
              "flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <BrainIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            {reads ? (
              <Link
                to="/memory"
                search={{
                  environmentId: props.environmentId,
                  ...(memory.memoryId === undefined
                    ? { q: memory.title }
                    : { memory: memory.memoryId }),
                }}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {memory.title}
              </Link>
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80">
                {memory.title}
              </span>
            )}
          </li>
        ))}
      </ul>
      {memories.length > VISIBLE ? (
        <div className={cn("flex py-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}>
          <InlineButton tone="muted" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer" : `Show all ${memories.length}`}
          </InlineButton>
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
