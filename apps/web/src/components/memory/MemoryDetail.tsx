import type {
  EnvironmentId,
  MemoryObservation,
  MemoryObservationDetail,
  MemoryOverview,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import ChatMarkdown from "../ChatMarkdown";
import { Skeleton } from "../ui/skeleton";
import { MemoryVerdictButtons } from "./MemoryConflicts";
import {
  isPendingRelation,
  MEMORY_GROUP_LABELS,
  memoryGroup,
  memoryRelationLabel,
} from "./memoryModel";
import { MemoryLink, memoryTimeLabel } from "./memoryParts";

/** One memory read in full, with the relations the overview knows for it. */
export function useMemoryDetail(
  environmentId: EnvironmentId,
  memoryId: number | null,
  overview: MemoryOverview | null,
) {
  const detail = useEnvironmentQuery(
    memoryId === null
      ? null
      : serverEnvironment.memoryObservation({ environmentId, input: { id: memoryId } }),
  );
  const observation = detail.data?.observation ?? null;
  const relations = useMemo(() => {
    if (observation === null) return [];
    const bySyncId = new Map((overview?.observations ?? []).map((entry) => [entry.syncId, entry]));
    return (overview?.relations ?? []).flatMap((relation) => {
      if (relation.relation === "not_conflict" || relation.judgmentStatus === "orphaned") return [];
      const from =
        relation.sourceId === observation.syncId
          ? "source"
          : relation.targetId === observation.syncId
            ? "target"
            : null;
      if (from === null) return [];
      const otherId = from === "source" ? relation.targetId : relation.sourceId;
      return [
        {
          relation,
          pending: isPendingRelation(relation),
          label: memoryRelationLabel(
            isPendingRelation(relation) ? "pending" : relation.relation,
            from,
          ),
          title: from === "source" ? relation.targetTitle : relation.sourceTitle,
          other: bySyncId.get(otherId) ?? null,
        },
      ];
    });
  }, [observation, overview]);
  return { detail, observation, relations };
}

export type MemoryDetailState = ReturnType<typeof useMemoryDetail>;

/** What kind of memory it is, where, and when: one line under its title. */
export function memorySummaryLine(observation: MemoryObservation) {
  return [
    `${MEMORY_GROUP_LABELS[memoryGroup(observation.type)]} · ${observation.type.replaceAll("_", " ")}`,
    observation.project,
    `saved ${memoryTimeLabel(observation.createdAt)}`,
    observation.revisionCount > 1
      ? `updated ${observation.revisionCount - 1} ${observation.revisionCount === 2 ? "time" : "times"}`
      : null,
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
}

/**
 * A memory's content, how it relates to others (with verdict buttons where Engram is waiting for
 * one), and what was saved around it in the same session.
 */
export function MemoryDetailBody(props: {
  readonly environmentId: EnvironmentId;
  readonly state: MemoryDetailState;
  readonly onOpenMemory: (id: number) => void;
  readonly onJudged: () => void;
}) {
  const { detail, observation, relations } = props.state;
  if (detail.error) return <p className="text-sm text-destructive-foreground">{detail.error}</p>;
  if (!detail.data) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  return (
    <>
      <ChatMarkdown
        text={detail.data.content}
        cwd={undefined}
        environmentId={props.environmentId}
      />
      {observation?.topicKey ? (
        <p className="text-xs text-muted-foreground">
          Topic <span className="font-mono">{observation.topicKey}</span>
        </p>
      ) : null}
      {relations.length > 0 ? (
        <MemoryList title="Relations">
          {relations.map((entry) => (
            <li key={entry.relation.syncId} className="flex flex-col gap-2 text-sm">
              <span>
                <span className="text-muted-foreground">{entry.label} </span>
                {entry.other ? (
                  <MemoryLink observation={entry.other} onOpen={props.onOpenMemory} />
                ) : (
                  <span>{entry.title || "a deleted memory"}</span>
                )}
              </span>
              {entry.pending ? (
                <MemoryVerdictButtons
                  environmentId={props.environmentId}
                  relation={entry.relation}
                  onJudged={props.onJudged}
                />
              ) : null}
            </li>
          ))}
        </MemoryList>
      ) : null}
      <SameSession detail={detail.data} onOpenMemory={props.onOpenMemory} />
    </>
  );
}

function SameSession(props: {
  readonly detail: MemoryObservationDetail;
  readonly onOpenMemory: (id: number) => void;
}) {
  const { before, after } = props.detail;
  if (before.length === 0 && after.length === 0) return null;
  return (
    <MemoryList title="Same session">
      {before.map((entry) => (
        <li key={entry.id} className="text-sm">
          <span className="text-muted-foreground">Before </span>
          <MemoryLink observation={entry} onOpen={props.onOpenMemory} />
        </li>
      ))}
      {after.map((entry) => (
        <li key={entry.id} className="text-sm">
          <span className="text-muted-foreground">After </span>
          <MemoryLink observation={entry} onOpen={props.onOpenMemory} />
        </li>
      ))}
    </MemoryList>
  );
}

function MemoryList(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex flex-col gap-2">{props.children}</ul>
    </section>
  );
}
