import { useAtomValue } from "@effect/atom-react";
import {
  type BoatDraftStartRow,
  type BoatDraftStartRowState,
  boatDraftStartRows,
} from "@t3tools/client-runtime/boat";
import { CheckIcon, CircleDotIcon, CircleIcon, XIcon } from "lucide-react";

import type { DraftId, DraftSessionState } from "../../composerDraftStore";
import { boatDraftStartAtom, clearBoatDraftStart } from "../../lib/boatDraftStart";
import { cn } from "../../lib/utils";
import { BoatIcon } from "../Icons";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { WorkLogRow } from "./WorkLog";

const STATE_WORDS: Record<BoatDraftStartRowState, string> = {
  pending: "Pending",
  active: "In progress",
  done: "Done",
  failed: "Failed",
};

// Static on purpose: a start can take a minute, and a spinner repaints the whole time.
function RowIcon({ state }: { readonly state: BoatDraftStartRowState }) {
  const className = "size-4 shrink-0 stroke-2";
  switch (state) {
    case "done":
      return <CheckIcon aria-hidden className={className} />;
    case "failed":
      return <XIcon aria-hidden className={className} />;
    case "active":
      return <CircleDotIcon aria-hidden className={className} />;
    case "pending":
      return <CircleIcon aria-hidden className={cn(className, "opacity-40")} />;
  }
}

function StartRow({ row }: { readonly row: BoatDraftStartRow }) {
  return (
    <WorkLogRow
      data-boat-draft-step={row.step}
      data-state={row.state}
      icon={
        <span className="text-icon-muted">
          <RowIcon state={row.state} />
        </span>
      }
      label={
        <span
          className={cn(
            "block truncate",
            row.state === "failed" && "text-destructive-foreground",
            row.state === "pending" && "text-secondary-label opacity-40",
          )}
        >
          <span className="sr-only">{STATE_WORDS[row.state]}: </span>
          {row.label}
        </span>
      }
      trailing={
        row.detail ? (
          <span className="max-w-1/2 min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            {row.detail}
          </span>
        ) : null
      }
    />
  );
}

/**
 * The steps of a Boat start for this draft, above its composer until the thread exists. A failure
 * keeps the draft and its message; "Retry" runs the send again.
 */
export function useBoatDraftStartBanner(input: {
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly onRetry: () => void;
}): ComposerBannerStackItem | null {
  const { draftId, draftThread, onRetry } = input;
  const start = useAtomValue(boatDraftStartAtom(draftId ?? ""));
  if (
    draftId === null ||
    start === null ||
    draftThread?.environmentSelection !== "boat" ||
    draftThread.promotedTo
  ) {
    return null;
  }
  const failed = start.error !== null;
  const rows = boatDraftStartRows(start);
  return {
    id: `boat-draft-start:${draftId}`,
    group: "environment",
    variant: failed ? "error" : "info",
    icon: <BoatIcon aria-hidden />,
    title: failed ? "Could not start on Boat" : "Starting on Boat",
    ...(failed ? { description: start.error } : {}),
    children: (
      <section aria-label="Starting on Boat" role="status">
        {rows.map((row) => (
          <StartRow key={row.step} row={row} />
        ))}
      </section>
    ),
    ...(failed
      ? {
          actions: (
            <>
              <Button size="xs" variant="ghost" onClick={() => clearBoatDraftStart(draftId)}>
                Dismiss
              </Button>
              <Button size="xs" variant="ghost" onClick={onRetry}>
                Retry
              </Button>
            </>
          ),
        }
      : {}),
  };
}
