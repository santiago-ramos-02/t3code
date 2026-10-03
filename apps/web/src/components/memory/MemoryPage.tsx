import { EnvironmentId, type MemoryOverview } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useMemoryEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { MemoryDetailSheet } from "./MemoryDetailSheet";
import { MemoryLink, memoryTimeLabel } from "./memoryParts";
import { MemoryActivity } from "./MemoryActivity";
import { MemoryBrainMap } from "./MemoryBrainMap";
import { MemoryConflictsButton } from "./MemoryConflicts";
import { MemoryHealthButton } from "./MemoryHealthButton";
import { MemoryObsidianExport } from "./MemoryObsidianExport";
import { MemoryScopeSentence } from "./MemoryScopeSentence";
import { buildMemoryGraph, relationsInProject, sessionSummaryPreview } from "./memoryModel";

// Engram does not announce changes, so an open page reads it again on this interval.
const OVERVIEW_REFRESH_MS = 30_000;
const ALL = "all";
// More dots than this stop reading as a map, and the layout gets slow to compute.
const MAP_LIMIT = 600;

/** What the agents on an environment remember, read from Engram. */
export function MemoryPage() {
  const search = useSearch({ from: "/memory" });
  const navigate = useNavigate({ from: "/memory" });
  const environments = useMemoryEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment =
    environments.find((entry) => entry.environmentId === search.environmentId) ??
    environments.find((entry) => entry.environmentId === primaryEnvironmentId) ??
    environments[0] ??
    null;
  const environmentId = environment?.environmentId ?? null;
  const overview = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.memoryOverview({ environmentId, input: {} }),
  );
  // Engram's project name, or null for every project; kept in the URL like other page scopes.
  const projectName = search.project ?? null;

  const openMemory = (id: number) =>
    void navigate({ search: (previous) => ({ ...previous, memory: id }) });
  const closeMemory = () =>
    void navigate({ search: ({ memory: _memory, ...previous }) => previous });
  useEscapeToGoBack(search.memory === undefined ? undefined : closeMemory);

  const { refresh } = overview;
  useEffect(() => {
    if (environmentId === null) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, OVERVIEW_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [environmentId, refresh]);

  const data = overview.data;
  const running = data?.status.state === "running";
  const relations = useMemo(
    () => (data ? relationsInProject(data.observations, data.relations, projectName) : []),
    [data, projectName],
  );

  const topbar = (
    <div className="flex w-full min-w-0 items-center gap-3 py-2">
      <WorkspaceBreadcrumb ariaLabel="Memory breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Memory</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto flex min-w-0 items-center gap-1">
        {running && environment ? (
          <>
            <MemoryConflictsButton
              environmentId={environment.environmentId}
              relations={relations}
              observations={data.observations}
              onOpenMemory={openMemory}
              onJudged={refresh}
            />
            <MemoryHealthButton
              environmentId={environment.environmentId}
              version={data.status.version}
            />
          </>
        ) : null}
        {running && environment ? (
          <MemoryObsidianExport
            environmentId={environment.environmentId}
            environmentLabel={environment.environmentLabel}
            local={environment.environmentId === primaryEnvironmentId}
            project={projectName}
          />
        ) : null}
        <Button
          onClick={refresh}
          aria-label="Refresh memory"
          aria-busy={overview.isPending}
          disabled={environmentId === null || overview.isPending}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={overview.isPending} />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          {topbar}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environment ? (
              <div className="mb-6">
                <MemoryScopeSentence
                  environmentIds={environments.map((entry) => entry.environmentId)}
                  environmentId={environment.environmentId}
                  onEnvironmentChange={(next) =>
                    void navigate({ search: () => ({ environmentId: next }) })
                  }
                  projects={running ? data.projects : []}
                  project={projectName}
                  onProjectChange={(next) =>
                    void navigate({
                      search: ({ project: _project, ...previous }) =>
                        next === null ? previous : { ...previous, project: next },
                    })
                  }
                />
              </div>
            ) : null}
            {environmentId === null ? (
              <MemoryEmpty
                title="No environment reads memory"
                description="Connect an environment running a T3 Code server that can read Engram."
              />
            ) : overview.error && !data ? (
              <MemoryEmpty title="Memory could not be read" description={overview.error} />
            ) : !data ? (
              <MemorySkeleton />
            ) : data.status.state === "not-installed" ? (
              <MemoryEmpty
                title="Engram is not installed"
                description={
                  <>
                    Engram gives agents a memory that lasts between sessions. Install it with Gentle
                    AI in{" "}
                    <InlineButton render={<Link to="/settings/gentle-ai" />}>Settings</InlineButton>
                    .
                  </>
                }
              />
            ) : data.status.state === "unreachable" ? (
              <MemoryEmpty
                title="Engram is not answering"
                description={
                  data.status.problem ?? "Its server on this environment could not be started."
                }
              />
            ) : (
              <MemoryContent
                environmentId={environmentId}
                overview={data}
                project={projectName}
                initialQuery={search.q ?? ""}
                readAt={overview.dataUpdatedAt}
                selectedMemoryId={search.memory ?? null}
                onOpenMemory={openMemory}
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {environmentId !== null ? (
        <MemoryDetailSheet
          environmentId={environmentId}
          memoryId={search.memory ?? null}
          overview={data}
          onOpenMemory={openMemory}
          onJudged={refresh}
          onClose={closeMemory}
        />
      ) : null}
    </SidebarInset>
  );
}

function MemoryContent(props: {
  readonly environmentId: EnvironmentId;
  readonly overview: MemoryOverview;
  readonly project: string | null;
  readonly initialQuery: string;
  // When the overview was read, which is "today" for the activity chart.
  readonly readAt: number;
  readonly selectedMemoryId: number | null;
  readonly onOpenMemory: (id: number) => void;
}) {
  const { overview, project } = props;
  const observations = useMemo(
    () =>
      project === null
        ? overview.observations
        : overview.observations.filter((entry) => entry.project === project),
    [overview.observations, project],
  );
  // Sessions that saved nothing and left no summary, such as short subagent runs, say nothing.
  const sessions = useMemo(
    () =>
      overview.sessions.filter(
        (entry) =>
          (project === null || entry.project === project) &&
          (entry.summary !== null || entry.observationCount > 0),
      ),
    [overview.sessions, project],
  );
  const graph = useMemo(
    () => buildMemoryGraph(overview.observations, overview.relations, project, MAP_LIMIT),
    [overview.observations, overview.relations, project],
  );

  if (overview.observations.length === 0) {
    return (
      <MemoryEmpty
        title="Nothing remembered yet"
        description="Agents save decisions, fixes and what they learn here as they work."
      />
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <MemoryBrainMap
        graph={graph}
        selectedMemoryId={props.selectedMemoryId}
        onOpenMemory={props.onOpenMemory}
      />
      {overview.observationsTruncated ? (
        <p className="-mt-6 text-xs text-muted-foreground">
          The page holds the newest {overview.observations.length.toLocaleString()} memories. Search
          reaches all of them.
        </p>
      ) : null}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <MemorySearch
          environmentId={props.environmentId}
          project={project}
          types={[...new Set(overview.observations.map((entry) => entry.type))].toSorted()}
          initialQuery={props.initialQuery}
          onOpenMemory={props.onOpenMemory}
        />
        <div className="flex min-w-0 flex-col gap-8">
          <MemoryActivity observations={observations} now={props.readAt} />
          <section className="flex min-w-0 flex-col gap-3">
            <h2 className="text-sm font-medium">Recent sessions</h2>
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sessions yet.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {sessions.slice(0, 12).map((session) => (
                  <li key={session.id} className="flex flex-col gap-1 py-3 first:pt-0">
                    <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                      <span className="truncate">{session.project ?? "No project"}</span>
                      <span className="shrink-0 tabular-nums">
                        {memoryTimeLabel(session.startedAt)}
                      </span>
                    </div>
                    <SessionSummary
                      summary={session.summary}
                      summaryMemoryId={session.summaryMemoryId ?? null}
                      observationCount={session.observationCount}
                      onOpenMemory={props.onOpenMemory}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function MemorySearch(props: {
  readonly environmentId: EnvironmentId;
  readonly project: string | null;
  readonly types: ReadonlyArray<string>;
  readonly initialQuery: string;
  readonly onOpenMemory: (id: number) => void;
}) {
  const [text, setText] = useState(props.initialQuery);
  const [query, setQuery] = useState(props.initialQuery.trim());
  const [type, setType] = useState<string>(ALL);
  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery(text.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [text]);
  const results = useEnvironmentQuery(
    query === ""
      ? null
      : serverEnvironment.memorySearch({
          environmentId: props.environmentId,
          input: {
            query,
            ...(props.project === null ? {} : { project: props.project }),
            ...(type === ALL ? {} : { type }),
          },
        }),
  );

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-sm font-medium">Search</h2>
      <div className="flex items-center gap-2">
        <Input
          type="search"
          aria-label="Search memory"
          placeholder="What do agents remember about…"
          value={text}
          onValueChange={setText}
        />
        <Select value={type} onValueChange={(value) => setType(value ?? ALL)}>
          <SelectTrigger aria-label="Memory type" className="w-auto min-w-0 shrink-0">
            <SelectValue>{type === ALL ? "Any type" : type.replaceAll("_", " ")}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={ALL}>Any type</SelectItem>
            {props.types.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry.replaceAll("_", " ")}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {query === "" ? null : results.error ? (
        <p className="text-sm text-destructive-foreground">{results.error}</p>
      ) : !results.data ? (
        <Skeleton className="h-16 w-full" />
      ) : results.data.results.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches “{query}”.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {results.data.results.map((result) => (
            <li key={result.observation.id} className="flex flex-col gap-1 py-3 first:pt-0">
              <MemoryLink observation={result.observation} onOpen={props.onOpenMemory} />
              <p className="line-clamp-2 text-sm text-muted-foreground">{result.snippet}</p>
              <p className="text-xs text-muted-foreground">
                {result.observation.type.replaceAll("_", " ")}
                {result.observation.project ? ` · ${result.observation.project}` : ""} ·{" "}
                {memoryTimeLabel(result.observation.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A session's summary in brief, opening the summary memory in full when there is one. */
function SessionSummary(props: {
  readonly summary: string | null;
  readonly summaryMemoryId: number | null;
  readonly observationCount: number;
  readonly onOpenMemory: (id: number) => void;
}) {
  const preview = props.summary === null ? "" : sessionSummaryPreview(props.summary);
  if (preview === "") {
    return (
      <p className="text-sm text-muted-foreground">
        No summary · {props.observationCount} {props.observationCount === 1 ? "memory" : "memories"}
      </p>
    );
  }
  const { summaryMemoryId } = props;
  return summaryMemoryId === null ? (
    <p className="line-clamp-4 text-sm">{preview}</p>
  ) : (
    <button
      type="button"
      className="line-clamp-4 cursor-pointer text-start text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => props.onOpenMemory(summaryMemoryId)}
    >
      {preview}
    </button>
  );
}

function MemoryEmpty(props: { readonly title: string; readonly description: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function MemorySkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-10">
        <Skeleton className="h-12 w-24" />
        <Skeleton className="h-12 w-24" />
        <Skeleton className="h-12 w-24" />
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}
