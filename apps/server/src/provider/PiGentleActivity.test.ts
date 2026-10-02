import { describe, expect, it } from "vite-plus/test";

import {
  gentleActivityUpdates,
  gentleTodoSteps,
  type GentleTaskSnapshot,
} from "./PiGentleActivity.ts";

const task = (
  id: string,
  status: string,
  items: ReadonlyArray<Record<string, string>> = [],
  version = 1,
) => ({
  summary: {
    id,
    agent: "explorer",
    label: `Map ${id}`,
    prompt: `Look into ${id}`,
    status,
    lastStep: "Reading files",
    error: status === "failed" ? "Gave up" : null,
  },
  thread: { version, items },
});

const widget = (...tasks: ReadonlyArray<ReturnType<typeof task>>) => [
  JSON.stringify({ schema: "gentle-agents.activity/v1", tasks }),
];

describe("gentleActivityUpdates", () => {
  it("maps each gentle-pi subagent to a V2 subagent status", () => {
    const published = new Map<string, GentleTaskSnapshot>();
    const { updates, live } = gentleActivityUpdates(
      widget(
        task("a", "queued"),
        task("b", "running", [{ kind: "text", text: "Found the reducer" }]),
        task("c", "timed_out"),
        task("d", "cancelled"),
        task("e", "failed"),
        task("f", "completed", [{ kind: "text", text: "All done" }]),
      ),
      published,
    );
    expect(updates.map((update) => [update.id, update.status])).toEqual([
      ["a", "pending"],
      ["b", "running"],
      ["c", "failed"],
      ["d", "cancelled"],
      ["e", "failed"],
      ["f", "completed"],
    ]);
    expect(updates.find((update) => update.id === "b")).toMatchObject({
      title: "Map b",
      prompt: "Look into b",
      progress: "Found the reducer",
      result: null,
    });
    expect(updates.find((update) => update.id === "e")?.result).toBe("Gave up");
    expect(updates.find((update) => update.id === "f")?.result).toBe("All done");
    // Only unfinished subagents keep the thread working.
    expect(live.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("skips redraws that changed nothing", () => {
    const published = new Map<string, GentleTaskSnapshot>();
    gentleActivityUpdates(widget(task("a", "running")), published);
    expect(gentleActivityUpdates(widget(task("a", "running")), published).updates).toEqual([]);
    expect(
      gentleActivityUpdates(widget(task("a", "running", [], 2)), published).updates,
    ).toHaveLength(1);
  });

  it("ignores widgets that are not gentle-pi activity", () => {
    expect(gentleActivityUpdates(["not json"], new Map())).toEqual({ updates: [], live: [] });
  });
});

describe("gentleTodoSteps", () => {
  it("turns gentle-pi's todo list into plan steps", () => {
    expect(
      gentleTodoSteps("todo", {
        gentleTodo: {
          tasks: [
            { title: "Plan", status: "done" },
            { title: "Build", status: "in_progress" },
            { title: "Ship", status: "pending" },
          ],
        },
      }),
    ).toEqual([
      { id: "todo-0", text: "Plan", status: "completed" },
      { id: "todo-1", text: "Build", status: "running" },
      { id: "todo-2", text: "Ship", status: "pending" },
    ]);
    expect(gentleTodoSteps("read", {})).toBeUndefined();
  });
});
