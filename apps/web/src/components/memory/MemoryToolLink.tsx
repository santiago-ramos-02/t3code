import type { EnvironmentId } from "@t3tools/contracts";
import { engramToolCall, engramToolResult } from "@t3tools/shared/engramTools";
import { Link } from "@tanstack/react-router";
import type { KeyboardEvent } from "react";

import { useMemoryEnvironments } from "../../state/environments";
import { InlineButton } from "../ui/button";

/**
 * The trailing part of an agent's Engram tool call in a thread: how many memories a search found,
 * and a link to the memory on the Memory page.
 */
export function MemoryToolLink(props: {
  readonly environmentId: EnvironmentId;
  readonly toolName: string | null;
  readonly input: unknown;
  readonly output: unknown;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const reads = useMemoryEnvironments().some(
    (environment) => environment.environmentId === props.environmentId,
  );
  const call = engramToolCall(props.toolName, props.input);
  if (call === undefined) return null;
  const result = engramToolResult(props.output);
  // The memory itself when its id is known, otherwise a search that finds it.
  const memory =
    call.kind === "save"
      ? result.id
      : call.kind === "update" || call.kind === "read"
        ? (result.id ?? call.id)
        : undefined;
  const query = call.kind === "search" ? call.query : call.kind === "save" ? call.title : undefined;
  const target = memory !== undefined ? { memory } : query !== undefined ? { q: query } : null;

  return (
    <>
      {call.kind === "search" && result.found !== undefined ? (
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
          {result.found === 0 ? "nothing found" : `${result.found} found`}
        </span>
      ) : null}
      {reads && target ? (
        <InlineButton
          render={<Link to="/memory" search={{ environmentId: props.environmentId, ...target }} />}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={props.onKeyDown}
        >
          Open in Memory
        </InlineButton>
      ) : null}
    </>
  );
}
