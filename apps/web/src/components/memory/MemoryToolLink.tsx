import type { ScopedThreadRef } from "@t3tools/contracts";
import { engramToolCall, engramToolResult } from "@t3tools/shared/engramTools";
import { Link } from "@tanstack/react-router";
import type { KeyboardEvent } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useMemoryEnvironments } from "../../state/environments";
import { InlineButton } from "../ui/button";

/**
 * The trailing part of an agent's Engram tool call in a thread: how many memories a search found,
 * and the memory it saved or read, opened in a tab beside the thread. A search, or a save whose id
 * Engram did not report, links to the Memory page's search instead.
 */
export function MemoryToolLink(props: {
  readonly threadRef: ScopedThreadRef;
  readonly toolName: string | null;
  readonly input: unknown;
  readonly output: unknown;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const reads = useMemoryEnvironments().some(
    (environment) => environment.environmentId === props.threadRef.environmentId,
  );
  const call = engramToolCall(props.toolName, props.input);
  if (call === undefined) return null;
  const result = engramToolResult(props.output);
  const memory =
    call.kind === "save"
      ? result.id
      : call.kind === "update" || call.kind === "read"
        ? (result.id ?? call.id)
        : undefined;
  const title = call.kind === "save" || call.kind === "update" ? call.title : undefined;
  const query = call.kind === "search" ? call.query : memory === undefined ? title : undefined;

  return (
    <>
      {call.kind === "search" && result.found !== undefined ? (
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
          {result.found === 0 ? "nothing found" : `${result.found} found`}
        </span>
      ) : null}
      {!reads ? null : memory !== undefined ? (
        <InlineButton
          onClick={(event) => {
            event.stopPropagation();
            useRightPanelStore
              .getState()
              .openMemory(props.threadRef, { id: memory, title: title ?? `Memory #${memory}` });
          }}
          onKeyDown={props.onKeyDown}
        >
          Open memory
        </InlineButton>
      ) : query !== undefined ? (
        <InlineButton
          render={
            <Link
              to="/memory"
              search={{ environmentId: props.threadRef.environmentId, q: query }}
            />
          }
          onClick={(event) => event.stopPropagation()}
          onKeyDown={props.onKeyDown}
        >
          Search in Memory
        </InlineButton>
      ) : null}
    </>
  );
}
