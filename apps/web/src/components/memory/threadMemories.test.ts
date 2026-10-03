import { type OrchestrationV2ProjectedTurnItem, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { threadSavedMemories } from "./threadMemories";

let position = 0;
const tool = (
  toolName: string,
  input: unknown,
  output: unknown,
  extra: {
    readonly visibility?: "local" | "inherited";
    readonly status?: "completed" | "failed";
  } = {},
): OrchestrationV2ProjectedTurnItem => {
  position += 1;
  const id = TurnItemId.make(`item-${position}`);
  const threadId = ThreadId.make("thread-1");
  return {
    position,
    visibility: extra.visibility ?? "local",
    sourceThreadId: threadId,
    sourceItemId: id,
    item: {
      type: "dynamic_tool",
      id,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: position,
      status: extra.status ?? "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-10-01T10:00:00Z"),
      toolName,
      input,
      output,
    },
  };
};

describe("threadSavedMemories", () => {
  it("lists what this thread saved, newest first, once per memory", () => {
    const memories = threadSavedMemories([
      tool("mcp__engram__mem_save", { title: "First" }, '{"id":1}'),
      tool("mcp__engram__mem_search", { query: "x" }, '{"results":[]}'),
      tool("mcp__engram__mem_save", { title: "Second" }, "saved"),
      tool("mcp__engram__mem_update", { id: 1, title: "First, revised" }, '{"id":1}'),
    ]);
    expect(memories.map((memory) => [memory.title, memory.memoryId])).toEqual([
      ["First, revised", 1],
      ["Second", undefined],
    ]);
  });

  it("skips failed calls and what a parent thread saved", () => {
    expect(
      threadSavedMemories([
        tool("mcp__engram__mem_save", { title: "Failed" }, "", { status: "failed" }),
        tool("mcp__engram__mem_save", { title: "Parent's" }, '{"id":2}', {
          visibility: "inherited",
        }),
      ]),
    ).toEqual([]);
  });
});
