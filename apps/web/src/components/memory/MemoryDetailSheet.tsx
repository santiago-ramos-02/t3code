import type { EnvironmentId, MemoryObservation, MemoryOverview } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import {
  isPendingRelation,
  MEMORY_GROUP_LABELS,
  memoryGroup,
  memoryIsoTime,
  memoryRelationLabel,
} from "./memoryModel";

const typeLabel = (type: string) => type.replaceAll("_", " ");

export const memoryTimeLabel = (value: string) => {
  const iso = memoryIsoTime(value);
  return iso === "" ? value : formatRelativeTimeLabel(iso);
};

/** One memory in full: what it says, how it relates to others, and what was saved around it. */
export function MemoryDetailSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly memoryId: number | null;
  readonly overview: MemoryOverview | null;
  readonly onOpenMemory: (id: number) => void;
  readonly onClose: () => void;
}) {
  const open = props.memoryId !== null;
  const detail = useEnvironmentQuery(
    props.memoryId === null
      ? null
      : serverEnvironment.memoryObservation({
          environmentId: props.environmentId,
          input: { id: props.memoryId },
        }),
  );
  const observation = detail.data?.observation;
  const bySyncId = useMemo(
    () => new Map((props.overview?.observations ?? []).map((entry) => [entry.syncId, entry])),
    [props.overview],
  );
  const relations = useMemo(() => {
    if (!observation) return [];
    return (props.overview?.relations ?? []).flatMap((relation) => {
      if (relation.relation === "not_conflict") return [];
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
          key: relation.syncId,
          label: memoryRelationLabel(
            isPendingRelation(relation) ? "pending" : relation.relation,
            from,
          ),
          title: from === "source" ? relation.targetTitle : relation.sourceTitle,
          other: bySyncId.get(otherId) ?? null,
        },
      ];
    });
  }, [observation, props.overview, bySyncId]);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle className="me-8">
            {observation?.title ?? (detail.error ? "Memory" : "Loading memory")}
          </SheetTitle>
          <SheetDescription>
            {observation ? (
              <>
                {MEMORY_GROUP_LABELS[memoryGroup(observation.type)]} · {typeLabel(observation.type)}
                {observation.project ? ` · ${observation.project}` : ""}
                {" · saved "}
                {memoryTimeLabel(observation.createdAt)}
                {observation.revisionCount > 1
                  ? ` · updated ${observation.revisionCount - 1} ${observation.revisionCount === 2 ? "time" : "times"}`
                  : ""}
              </>
            ) : null}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          {detail.error ? (
            <p className="text-sm text-destructive-foreground">{detail.error}</p>
          ) : !detail.data ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : (
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
                  {relations.map((relation) => (
                    <li key={relation.key} className="text-sm">
                      <span className="text-muted-foreground">{relation.label} </span>
                      {relation.other ? (
                        <MemoryLink observation={relation.other} onOpen={props.onOpenMemory} />
                      ) : (
                        <span>{relation.title || "a deleted memory"}</span>
                      )}
                    </li>
                  ))}
                </MemoryList>
              ) : null}
              {detail.data.before.length > 0 || detail.data.after.length > 0 ? (
                <MemoryList title="Same session">
                  {detail.data.before.map((entry) => (
                    <li key={entry.id} className="text-sm">
                      <span className="text-muted-foreground">Before </span>
                      <MemoryLink observation={entry} onOpen={props.onOpenMemory} />
                    </li>
                  ))}
                  {detail.data.after.map((entry) => (
                    <li key={entry.id} className="text-sm">
                      <span className="text-muted-foreground">After </span>
                      <MemoryLink observation={entry} onOpen={props.onOpenMemory} />
                    </li>
                  ))}
                </MemoryList>
              ) : null}
            </>
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

function MemoryList(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex flex-col gap-1.5">{props.children}</ul>
    </section>
  );
}

export function MemoryLink(props: {
  readonly observation: MemoryObservation;
  readonly onOpen: (id: number) => void;
}) {
  return (
    // Titles are long and wrap, which InlineButton does not.
    <button
      type="button"
      className="cursor-pointer text-start font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => props.onOpen(props.observation.id)}
    >
      {props.observation.title}
    </button>
  );
}
