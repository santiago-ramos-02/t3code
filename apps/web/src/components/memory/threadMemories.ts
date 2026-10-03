import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { engramToolCall, engramToolResult } from "@t3tools/shared/engramTools";

export interface ThreadMemory {
  readonly key: string;
  readonly title: string;
  // Engram's id for it, when its answer said; otherwise the Memory page searches by title.
  readonly memoryId: number | undefined;
}

/**
 * The memories agents saved or updated in this thread, newest first. A memory updated after it was
 * saved is listed once, under its latest title. Memories from a parent thread's history are not
 * this thread's.
 */
export function threadSavedMemories(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<ThreadMemory> {
  const memories = new Map<string, ThreadMemory>();
  for (const { item, visibility } of items) {
    if (visibility !== "local" || item.type !== "dynamic_tool" || item.status !== "completed") {
      continue;
    }
    const call = engramToolCall(item.toolName, item.input);
    if (call?.kind !== "save" && call?.kind !== "update") continue;
    const memoryId =
      engramToolResult(item.output).id ?? (call.kind === "update" ? call.id : undefined);
    const key = memoryId === undefined ? `item:${item.id}` : `memory:${memoryId}`;
    const previous = memories.get(key);
    const title = call.title ?? previous?.title;
    if (title === undefined) continue;
    // Re-inserting moves it to the end, which is its newest position.
    memories.delete(key);
    memories.set(key, { key, title, memoryId });
  }
  return [...memories.values()].toReversed();
}
