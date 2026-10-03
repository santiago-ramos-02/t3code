import type { MemoryObservation, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useProjects, useThreadShell, useThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { memoryProjectChoices } from "./memoryModel";
import { memoryTimeLabel } from "./memoryParts";
import { threadSavedMemories } from "./threadMemories";

const RECENT = 15;

/**
 * The thread's memory surface: what agents saved in this thread, a search over its project's
 * memories, and the project's newest ones. Each opens in a tab beside the thread.
 */
export function MemoriesPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId } = props.threadRef;
  const thread = useThreadShell(props.threadRef);
  const projects = useProjects();
  const items = useThreadVisibleTurnItems(props.threadRef);
  const saved = useMemo(() => threadSavedMemories(items), [items]);
  const overview = useEnvironmentQuery(
    serverEnvironment.memoryOverview({ environmentId, input: {} }),
  ).data;
  // The Engram project this thread's T3 project is, when one matches.
  const projectName = useMemo(() => {
    const project = projects.find(
      (entry) => entry.environmentId === environmentId && entry.id === thread?.projectId,
    );
    if (!project || !overview) return null;
    return (
      memoryProjectChoices(overview.projects, [project]).find((choice) => choice.project !== null)
        ?.name ?? null
    );
  }, [projects, environmentId, thread?.projectId, overview]);
  const recent = useMemo(
    () =>
      (overview?.observations ?? [])
        .filter((entry) => projectName !== null && entry.project === projectName)
        .slice(0, RECENT),
    [overview, projectName],
  );

  const open = (id: number, title: string) =>
    useRightPanelStore.getState().openMemory(props.threadRef, { id, title });

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-6 p-4">
        <Section title="Saved in this thread">
          {saved.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Agents have not saved memories in this thread yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {saved.map((memory) => (
                <li key={memory.key} className="text-sm">
                  {memory.memoryId === undefined ? (
                    <span className="font-medium">{memory.title}</span>
                  ) : (
                    <MemoryRowButton
                      title={memory.title}
                      onOpen={() => open(memory.memoryId ?? 0, memory.title)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <MemoriesSearch
          threadRef={props.threadRef}
          project={projectName}
          onOpen={(observation) => open(observation.id, observation.title)}
        />
        {projectName !== null ? (
          <Section title={`Recent in ${projectName}`}>
            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing remembered yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {recent.map((observation) => (
                  <li key={observation.id} className="flex flex-col gap-0.5 text-sm">
                    <MemoryRowButton
                      title={observation.title}
                      onOpen={() => open(observation.id, observation.title)}
                    />
                    <span className="text-xs text-muted-foreground">
                      {observation.type.replaceAll("_", " ")} ·{" "}
                      {memoryTimeLabel(observation.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : null}
        <InlineButton
          tone="muted"
          className="self-start"
          render={
            <Link
              to="/memory"
              search={{ environmentId, ...(projectName === null ? {} : { project: projectName }) }}
            />
          }
        >
          Open the Memory page
        </InlineButton>
      </div>
    </ScrollArea>
  );
}

function MemoriesSearch(props: {
  readonly threadRef: ScopedThreadRef;
  readonly project: string | null;
  readonly onOpen: (observation: MemoryObservation) => void;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery(text.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [text]);
  const results = useEnvironmentQuery(
    query === ""
      ? null
      : serverEnvironment.memorySearch({
          environmentId: props.threadRef.environmentId,
          input: { query, ...(props.project === null ? {} : { project: props.project }) },
        }),
  );
  return (
    <Section title="Search">
      <Input
        type="search"
        size="sm"
        aria-label="Search memory"
        placeholder={props.project ? `Search ${props.project}'s memories` : "Search memories"}
        value={text}
        onValueChange={setText}
      />
      {query === "" ? null : results.error ? (
        <p className="text-sm text-destructive-foreground">{results.error}</p>
      ) : !results.data ? (
        <p className="text-sm text-muted-foreground">Searching…</p>
      ) : results.data.results.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches “{query}”.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {results.data.results.map((result) => (
            <li key={result.observation.id} className="flex flex-col gap-0.5 text-sm">
              <MemoryRowButton
                title={result.observation.title}
                onOpen={() => props.onOpen(result.observation)}
              />
              <span className="line-clamp-2 text-xs text-muted-foreground">{result.snippet}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function MemoryRowButton(props: { readonly title: string; readonly onOpen: () => void }) {
  return (
    // Titles are long and wrap, which InlineButton does not.
    <button
      type="button"
      className="cursor-pointer text-start font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={props.onOpen}
    >
      {props.title}
    </button>
  );
}
