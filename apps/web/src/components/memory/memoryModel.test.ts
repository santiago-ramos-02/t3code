import type { MemoryObservation, MemoryRelation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMemoryGraph,
  engramProjectNames,
  memoryProjectChoices,
  memoryActivity,
  memoryGroup,
  parseMemoryTime,
  pendingConflicts,
  relationsInProject,
} from "./memoryModel";

const memory = (id: number, extra: Partial<MemoryObservation> = {}): MemoryObservation => ({
  id,
  syncId: `obs-${id}`,
  sessionId: "s1",
  type: "decision",
  title: `Memory ${id}`,
  project: "t3code",
  scope: "project",
  topicKey: null,
  revisionCount: 1,
  createdAt: "2026-10-01 10:00:00",
  updatedAt: "2026-10-01 10:00:00",
  ...extra,
});

const link = (
  source: number,
  target: number,
  relation: string,
  judgmentStatus = "judged",
): MemoryRelation => ({
  syncId: `rel-${source}-${target}`,
  relation,
  judgmentStatus,
  sourceId: `obs-${source}`,
  targetId: `obs-${target}`,
  sourceTitle: `Memory ${source}`,
  targetTitle: `Memory ${target}`,
  updatedAt: "2026-10-01 10:00:00",
});

describe("memoryGroup", () => {
  it("folds Engram's types into the groups the brain map colors", () => {
    expect(
      ["decision", "architecture", "pattern", "preference", "config"].map(memoryGroup),
    ).toEqual(["decisions", "decisions", "decisions", "decisions", "decisions"]);
    expect(["bugfix", "discovery", "learning", "passive"].map(memoryGroup)).toEqual([
      "findings",
      "findings",
      "findings",
      "findings",
    ]);
    expect(memoryGroup("session_summary")).toBe("sessions");
    expect(memoryGroup("manual")).toBe("other");
  });
});

describe("buildMemoryGraph", () => {
  it("links memories that are both present, and skips verdicts that say they are unrelated", () => {
    const graph = buildMemoryGraph(
      [memory(1), memory(2), memory(3)],
      [link(1, 2, "related"), link(2, 9, "related"), link(1, 3, "not_conflict")],
      null,
    );
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.kind])).toEqual([
      ["obs-1", "obs-2", "related"],
    ]);
  });

  it("marks what was superseded and what is in conflict or waiting for a verdict", () => {
    const graph = buildMemoryGraph(
      [memory(1), memory(2), memory(3), memory(4), memory(5)],
      [link(2, 1, "supersedes"), link(3, 4, "conflicts_with"), link(4, 5, "pending", "pending")],
      null,
    );
    const node = (id: number) => graph.nodes.find((entry) => entry.id === `obs-${id}`);
    expect(node(1)?.superseded).toBe(true);
    expect(node(2)?.superseded).toBe(false);
    expect([3, 4, 5].map((id) => node(id)?.conflicted)).toEqual([true, true, true]);
    expect(node(1)?.conflicted).toBe(false);
  });

  it("keeps one project's memories, and only links inside it", () => {
    const graph = buildMemoryGraph(
      [memory(1), memory(2, { project: "other" })],
      [link(1, 2, "related")],
      "t3code",
    );
    expect(graph.nodes.map((node) => node.id)).toEqual(["obs-1"]);
    expect(graph.edges).toEqual([]);
  });
});

describe("buildMemoryGraph threads and limit", () => {
  it("chains each session's memories in the order they were saved", () => {
    const graph = buildMemoryGraph(
      [
        memory(3, { createdAt: "2026-10-01 12:00:00" }),
        memory(1, { createdAt: "2026-10-01 10:00:00" }),
        memory(9, { sessionId: "s2" }),
        memory(2, { createdAt: "2026-10-01 11:00:00" }),
      ],
      [],
      null,
    );
    expect(graph.threads).toEqual([
      { source: "obs-1", target: "obs-2" },
      { source: "obs-2", target: "obs-3" },
    ]);
  });

  it("keeps the newest memories and says how many it left out", () => {
    const graph = buildMemoryGraph(
      [
        memory(1, { createdAt: "2026-10-01 10:00:00" }),
        memory(2, { createdAt: "2026-10-02 10:00:00" }),
        memory(3, { createdAt: "2026-10-03 10:00:00" }),
      ],
      [link(1, 2, "related")],
      null,
      2,
    );
    expect(graph.nodes.map((node) => node.id)).toEqual(["obs-3", "obs-2"]);
    expect(graph.edges).toEqual([]);
    expect(graph.hidden).toBe(1);
  });
});

describe("relationsInProject", () => {
  it("keeps relations that touch the project's memories", () => {
    const memories = [memory(1), memory(2, { project: "other" }), memory(3, { project: "other" })];
    const relations = [link(1, 2, "related"), link(2, 3, "related")];
    expect(relationsInProject(memories, relations, "t3code").map((r) => r.syncId)).toEqual([
      "rel-1-2",
    ]);
    expect(relationsInProject(memories, relations, null)).toBe(relations);
  });
});

describe("pendingConflicts", () => {
  it("lists relations still waiting for a verdict, newest first", () => {
    const older = { ...link(1, 2, "pending", "pending"), updatedAt: "2026-09-01 10:00:00" };
    const newer = { ...link(3, 4, "pending", "pending"), updatedAt: "2026-10-01 10:00:00" };
    expect(pendingConflicts([older, link(5, 6, "related"), newer]).map((r) => r.syncId)).toEqual([
      newer.syncId,
      older.syncId,
    ]);
  });

  it("drops pairs Engram marked orphaned because one memory was deleted", () => {
    const gone = { ...link(1, 9, "pending", "orphaned"), targetTitle: "" };
    expect(pendingConflicts([gone, link(1, 2, "pending", "pending")]).map((r) => r.syncId)).toEqual(
      ["rel-1-2"],
    );
  });
});

describe("memoryActivity", () => {
  it("counts memories per day over the window, oldest first, with empty days", () => {
    const now = parseMemoryTime("2026-10-03 12:00:00");
    const activity = memoryActivity(
      [
        memory(1, { createdAt: "2026-10-03 08:00:00" }),
        memory(2, { createdAt: "2026-10-03 09:00:00" }),
        memory(3, { createdAt: "2026-10-01 09:00:00" }),
        memory(4, { createdAt: "2026-08-01 09:00:00" }),
      ],
      3,
      now,
    );
    expect(activity).toEqual([
      { day: "2026-10-01", count: 1 },
      { day: "2026-10-02", count: 0 },
      { day: "2026-10-03", count: 2 },
    ]);
  });
});

describe("parseMemoryTime", () => {
  it("reads Engram's UTC timestamps", () => {
    expect(new Date(parseMemoryTime("2026-10-01 10:00:00")).toISOString()).toBe(
      "2026-10-01T10:00:00.000Z",
    );
    expect(new Date(parseMemoryTime("2026-10-01T10:00:00Z")).toISOString()).toBe(
      "2026-10-01T10:00:00.000Z",
    );
    // Session times carry Go's nanoseconds.
    expect(new Date(parseMemoryTime("2026-10-03 06:20:28.579015200")).toISOString()).toBe(
      "2026-10-03T06:20:28.579Z",
    );
  });
});

describe("memoryProjectChoices", () => {
  const project = (title: string, workspaceRoot: string, repositoryName?: string) => ({
    title,
    workspaceRoot,
    repositoryIdentity: repositoryName === undefined ? null : { name: repositoryName },
  });

  it("pairs Engram's projects with T3 projects by repository or folder name", () => {
    const repo = project("T3 Code", "/home/me/t3code-main", "T3Code");
    // A Windows checkout without a remote: Engram names it after the folder.
    const folder = project("Mapp Stock", "C:\\Users\\me\\MappStock\\");
    const choices = memoryProjectChoices(
      [
        { name: "t3code", observationCount: 120, sessionCount: 3 },
        { name: "mappstock", observationCount: 9, sessionCount: 1 },
        { name: "ivp", observationCount: 2, sessionCount: 1 },
      ],
      [repo, folder],
    );
    expect(choices.map((choice) => [choice.name, choice.project?.title ?? null])).toEqual([
      ["t3code", "T3 Code"],
      ["mappstock", "Mapp Stock"],
      ["ivp", null],
    ]);
  });

  it("reads names the way Engram canonicalizes them", () => {
    expect(engramProjectNames(project("x", "/a/My--Repo__X"))).toContain("my-repo_x");
  });
});
