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
import { TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MemoryLink } from "./MemoryDetailSheet";
import { pendingConflicts } from "./memoryModel";

const VISIBLE = 4;

// Engram's verdicts in plain words, read as "the first memory … the second".
const VERDICTS: ReadonlyArray<{ readonly verdict: MemoryVerdict; readonly label: string }> = [
  { verdict: "supersedes", label: "First replaces second" },
  { verdict: "conflicts_with", label: "They contradict" },
  { verdict: "compatible", label: "Both hold" },
  { verdict: "scoped", label: "Different situations" },
  { verdict: "not_conflict", label: "Unrelated" },
];

/**
 * Pairs of memories Engram flagged as possibly disagreeing, each settled with one verdict. Agents
 * read the verdict, so a replaced memory stops steering them.
 */
export function MemoryConflicts(props: {
  readonly environmentId: EnvironmentId;
  readonly relations: ReadonlyArray<MemoryRelation>;
  readonly observations: ReadonlyArray<MemoryObservation>;
  readonly onOpenMemory: (id: number) => void;
  readonly onJudged: () => void;
}) {
  const conflicts = useMemo(() => pendingConflicts(props.relations), [props.relations]);
  const bySyncId = useMemo(
    () => new Map(props.observations.map((entry) => [entry.syncId, entry])),
    [props.observations],
  );
  const [showAll, setShowAll] = useState(false);
  // Verdicts given on this page, hidden right away instead of waiting for the next read.
  const [judged, setJudged] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ readonly syncId: string; readonly text: string } | null>(
    null,
  );
  const judge = useAtomCommand(serverEnvironment.judgeMemory, {
    reportFailure: false,
    reportDefect: false,
  });

  const open = conflicts.filter((relation) => !judged.has(relation.syncId));
  if (open.length === 0) return null;
  const shown = showAll ? open : open.slice(0, VISIBLE);

  const give = async (relation: MemoryRelation, verdict: MemoryVerdict) => {
    setBusy(relation.syncId);
    setError(null);
    const result = await judge({
      environmentId: props.environmentId,
      input: { relationSyncId: relation.syncId, verdict },
    });
    setBusy(null);
    if (result._tag === "Success") {
      setJudged((previous) => new Set(previous).add(relation.syncId));
      props.onJudged();
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError({
        syncId: relation.syncId,
        text: failure instanceof Error ? failure.message : "Engram did not take the verdict.",
      });
    }
  };

  const side = (syncId: string, title: string) => {
    const observation = bySyncId.get(syncId);
    return observation ? (
      <MemoryLink observation={observation} onOpen={props.onOpenMemory} />
    ) : (
      <span className="font-medium">{title || "A deleted memory"}</span>
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Memories that need your call">
      <h2 className="flex items-center gap-1.5 text-sm font-medium">
        <TriangleAlertIcon aria-hidden className="size-3.5 text-warning" />
        Needs your call
        <span className="font-normal text-muted-foreground tabular-nums">{open.length}</span>
      </h2>
      <ul className="flex flex-col divide-y rounded-lg border">
        {shown.map((relation) => (
          <li key={relation.syncId} className="flex flex-col gap-3 p-3">
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
            <div className="flex flex-wrap gap-1.5">
              {VERDICTS.map(({ verdict, label }) => (
                <Button
                  key={verdict}
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void give(relation, verdict)}
                >
                  {label}
                </Button>
              ))}
            </div>
            {error?.syncId === relation.syncId ? (
              <p className="text-xs text-destructive-foreground">{error.text}</p>
            ) : null}
          </li>
        ))}
      </ul>
      {open.length > VISIBLE ? (
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show fewer" : `Show all ${open.length}`}
        </Button>
      ) : null}
    </section>
  );
}
