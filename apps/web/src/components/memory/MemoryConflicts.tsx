import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MemoryObservation,
  MemoryRelation,
  MemoryVerdict,
} from "@t3tools/contracts";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { MemoryLink } from "./memoryParts";
import { pendingConflicts } from "./memoryModel";

// Engram's verdicts in plain words, read as "the first memory … the second".
const VERDICTS: ReadonlyArray<{ readonly verdict: MemoryVerdict; readonly label: string }> = [
  { verdict: "supersedes", label: "First replaces second" },
  { verdict: "conflicts_with", label: "They contradict" },
  { verdict: "compatible", label: "Both hold" },
  { verdict: "scoped", label: "Different situations" },
  { verdict: "not_conflict", label: "Unrelated" },
];

/** The verdicts for one flagged pair; once one is given, it says which. */
export function MemoryVerdictButtons(props: {
  readonly environmentId: EnvironmentId;
  readonly relation: MemoryRelation;
  readonly onJudged: (relation: MemoryRelation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [given, setGiven] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const judge = useAtomCommand(serverEnvironment.judgeMemory, {
    reportFailure: false,
    reportDefect: false,
  });

  const give = async (verdict: MemoryVerdict, label: string) => {
    setBusy(true);
    setError(null);
    const result = await judge({
      environmentId: props.environmentId,
      input: { relationSyncId: props.relation.syncId, verdict },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setGiven(label);
      props.onJudged(props.relation);
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Engram did not take the verdict.");
    }
  };

  if (given !== null) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckIcon aria-hidden className="size-3.5 text-success" />
        {given}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {VERDICTS.map(({ verdict, label }) => (
          <Button
            key={verdict}
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void give(verdict, label)}
          >
            {label}
          </Button>
        ))}
      </div>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

/**
 * The header's way to the pairs Engram flagged as possibly disagreeing: how many there are, and a
 * panel to settle each with one verdict. Renders nothing when none are waiting.
 */
export function MemoryConflictsButton(props: {
  readonly environmentId: EnvironmentId;
  readonly relations: ReadonlyArray<MemoryRelation>;
  readonly observations: ReadonlyArray<MemoryObservation>;
  readonly onOpenMemory: (id: number) => void;
  readonly onJudged: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Verdicts given here leave the list right away instead of waiting for the next read.
  const [judged, setJudged] = useState<ReadonlySet<string>>(() => new Set());
  const conflicts = useMemo(
    () => pendingConflicts(props.relations).filter((relation) => !judged.has(relation.syncId)),
    [props.relations, judged],
  );
  const bySyncId = useMemo(
    () => new Map(props.observations.map((entry) => [entry.syncId, entry])),
    [props.observations],
  );
  if (conflicts.length === 0 && !open) return null;

  const openMemory = (id: number) => {
    setOpen(false);
    props.onOpenMemory(id);
  };
  const side = (syncId: string, title: string) => {
    const observation = bySyncId.get(syncId);
    return observation ? (
      <MemoryLink observation={observation} onOpen={openMemory} />
    ) : (
      <span className="font-medium">{title}</span>
    );
  };

  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <TriangleAlertIcon aria-hidden className="text-warning" />
        {conflicts.length} {conflicts.length === 1 ? "needs" : "need"} your call
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup side="right">
          <SheetHeader>
            <SheetTitle className="me-8">Needs your call</SheetTitle>
            <SheetDescription>
              Engram flagged these memories as possibly disagreeing. Pick how each pair relates.
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6">
            {conflicts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing left to settle.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {conflicts.map((relation) => (
                  <li key={relation.syncId} className="flex flex-col gap-3 py-4 first:pt-0">
                    <div className="flex flex-col gap-1 text-sm">
                      <div className="flex gap-2">
                        <span className="w-12 shrink-0 text-muted-foreground">First</span>
                        {side(relation.sourceId, relation.sourceTitle)}
                      </div>
                      <div className="flex gap-2">
                        <span className="w-12 shrink-0 text-muted-foreground">Second</span>
                        {side(relation.targetId, relation.targetTitle)}
                      </div>
                    </div>
                    <MemoryVerdictButtons
                      environmentId={props.environmentId}
                      relation={relation}
                      onJudged={(settled) => {
                        setJudged((previous) => new Set(previous).add(settled.syncId));
                        props.onJudged();
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}
