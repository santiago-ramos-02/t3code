import { describe, expect, it } from "vite-plus/test";

import { gentleTodoSteps, gentleWorkflowName, readGentleActivity } from "./PiGentleActivity.ts";

const task = (
  id: string,
  status: string,
  items: ReadonlyArray<Record<string, unknown>> = [],
  extra: { readonly summary?: Record<string, unknown>; readonly total?: number } = {},
) => ({
  summary: {
    id,
    agent: "explorer",
    label: `Map ${id}`,
    prompt: `Look into ${id}`,
    status,
    lastStep: "Reading files",
    error: status === "failed" ? "Gave up" : null,
    ...extra.summary,
  },
  thread: {
    version: 1,
    items,
    ...(extra.total === undefined ? {} : { total: extra.total }),
  },
});

const widget = (...tasks: ReadonlyArray<ReturnType<typeof task>>) => [
  JSON.stringify({ schema: "gentle-agents.activity/v1", tasks }),
];

describe("readGentleActivity", () => {
  it("maps each gentle-pi subagent to a V2 subagent status", () => {
    const tasks =
      readGentleActivity(
        widget(
          task("a", "queued"),
          task("b", "running", [{ kind: "text", text: "Found the reducer" }]),
          task("c", "timed_out"),
          task("d", "cancelled"),
          task("e", "failed"),
          task("f", "completed", [{ kind: "text", text: "All done" }]),
        ),
      ) ?? [];
    expect(tasks.map((entry) => [entry.id, entry.status, entry.terminal])).toEqual([
      ["a", "pending", false],
      ["b", "running", false],
      ["c", "failed", true],
      ["d", "cancelled", true],
      ["e", "failed", true],
      ["f", "completed", true],
    ]);
    expect(tasks.find((entry) => entry.id === "b")).toMatchObject({
      title: "Map b",
      agent: "explorer",
      prompt: "Look into b",
      progress: "Found the reducer",
      result: null,
    });
    expect(tasks.find((entry) => entry.id === "e")?.result).toBe("Gave up");
    expect(tasks.find((entry) => entry.id === "f")?.result).toBe("All done");
  });

  it("keeps the Gentle AI agent apart from what the subagent was asked", () => {
    const tasks =
      readGentleActivity(
        widget(
          task("a", "running"),
          task("b", "running", [], { summary: { label: "" } }),
          task("c", "running", [], { summary: { agent: " ", label: "Look around" } }),
          task("d", "running", [], { summary: { agent: "", label: "" } }),
        ),
      ) ?? [];
    expect(tasks.map((entry) => [entry.title, entry.agent])).toEqual([
      ["Map a", "explorer"],
      ["explorer", "explorer"],
      ["Look around", null],
      ["Pi subagent", null],
    ]);
  });

  it("reads what a newer gentle-pi adds: mode, model and numbered thread items", () => {
    const [entry] =
      readGentleActivity(
        widget(
          task(
            "a",
            "running",
            [
              { kind: "text", text: "Reading" },
              { kind: "tool", name: "read", args: '{"path":"a.ts"}', running: true, output: "" },
            ],
            { summary: { mode: "background", model: "claude-bridge/claude-sonnet-5-5" }, total: 7 },
          ),
        ),
      ) ?? [];
    expect(entry).toMatchObject({ background: true, model: "claude-bridge/claude-sonnet-5-5" });
    // The two kept items are the task's 6th and 7th.
    expect(entry?.items.map((kept) => kept.number)).toEqual([5, 6]);
  });

  it("leaves out what an older gentle-pi does not send", () => {
    const [entry] =
      readGentleActivity(
        widget(
          task("a", "running", [{ kind: "text", text: "Reading" }], {
            summary: { model: "default" },
          }),
        ),
      ) ?? [];
    expect(entry).toMatchObject({ background: false, model: null, items: [] });
  });

  it("reads the start and end times a newer gentle-pi sends, null until they happen", () => {
    const tasks =
      readGentleActivity(
        widget(
          task("a", "completed", [], { summary: { startedAt: 1_000, endedAt: 4_000 } }),
          task("b", "running", [], { summary: { startedAt: 2_000, endedAt: null } }),
          task("c", "queued", [], { summary: { startedAt: null, endedAt: null } }),
          task("d", "completed"),
        ),
      ) ?? [];
    expect(tasks.map((entry) => [entry.startedAt, entry.endedAt])).toEqual([
      [1_000, 4_000],
      [2_000, null],
      [null, null],
      [null, null],
    ]);
  });

  it("ignores widgets that are not gentle-pi activity", () => {
    expect(readGentleActivity(["not json"])).toBeNull();
    expect(readGentleActivity(undefined)).toBeNull();
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

describe("gentleWorkflowName", () => {
  it("humanizes the feature a prompt's ODD document names", () => {
    expect(
      gentleWorkflowName(
        ["Look around", "Spec: odd/tasks/boat-fork-runtime.md, T2, S3-S4", "odd/tasks/other.md"],
        "Add a runtime",
      ),
    ).toBe("Boat fork runtime");
  });

  it("uses the request's first line, capped, then the default", () => {
    expect(gentleWorkflowName(["Look around"], "  Add dark mode \nplease")).toBe("Add dark mode");
    const capped = gentleWorkflowName([], "x".repeat(200));
    expect(capped).toHaveLength(72);
    expect(capped.endsWith("...")).toBe(true);
    expect(gentleWorkflowName([], " \n")).toBe("ODD workflow");
  });
});
