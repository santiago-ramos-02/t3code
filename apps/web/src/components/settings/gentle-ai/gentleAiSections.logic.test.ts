import { describe, expect, it } from "vite-plus/test";

import {
  formatGentleAiBytes,
  gentleAiProjectCwd,
  gentleAiReviewCloneDisabled,
  gentleAiReviewGlobalEnabled,
  gentleAiReviewStoreSummary,
  gentleAiToolInstalled,
  gentleAiToolSummary,
  gentleAiUninstallPlanParams,
  gentleAiUninstallRunParams,
  toggleGentleAiId,
} from "./gentleAiSections.logic";

const projects = [{ cwd: "/a" }, { cwd: "/b" }];

describe("gentleAiProjectCwd", () => {
  it("keeps the user's choice while the project exists", () => {
    expect(gentleAiProjectCwd(projects, "/b")).toBe("/b");
  });

  it("falls back to the first project when the choice is gone or unset", () => {
    expect(gentleAiProjectCwd(projects, "/gone")).toBe("/a");
    expect(gentleAiProjectCwd(projects, null)).toBe("/a");
  });

  it("has no cwd without projects", () => {
    expect(gentleAiProjectCwd([], "/a")).toBeNull();
  });
});

describe("community tools", () => {
  const tool = {
    id: "codegraph",
    name: "CodeGraph",
    description: "",
    repoUrl: "",
    cliAvailable: true,
    agents: [
      { agent: "claude-code", detected: true, configured: true },
      { agent: "codex", detected: true, configured: false },
      { agent: "kiro-ide", detected: false, configured: false },
    ],
  };
  const names = new Map([["claude-code", "Claude Code"]]);

  it("summarizes only detected agents", () => {
    expect(gentleAiToolSummary(tool, names)).toBe(
      "CLI installed · Configured for Claude Code · Not configured for codex",
    );
  });

  it("counts a tool installed only when every detected agent is wired", () => {
    expect(gentleAiToolInstalled(tool)).toBe(false);
    expect(
      gentleAiToolInstalled({ ...tool, agents: tool.agents.filter((a) => a.agent !== "codex") }),
    ).toBe(true);
  });
});

const reviewMode = (global: string, clone_local: string) => ({
  scope: "global",
  status: { global, clone_local, effective: "on", source: "default" },
});

describe("review mode", () => {
  it("treats an unchosen global switch as on", () => {
    expect(gentleAiReviewGlobalEnabled(reviewMode("", ""))).toBe(true);
    expect(gentleAiReviewGlobalEnabled(reviewMode("off", ""))).toBe(false);
  });

  it("reads the clone switch from the clone's own override", () => {
    expect(gentleAiReviewCloneDisabled(reviewMode("on", "off"))).toBe(true);
    expect(gentleAiReviewCloneDisabled(reviewMode("off", ""))).toBe(false);
  });
});

describe("gentleAiReviewStoreSummary", () => {
  const entry = (present: boolean, bytes: number) => ({
    name: "n",
    path: "p",
    reason: "",
    present,
    files: 1,
    bytes,
    removed: false,
  });

  it("counts only removable entries still on disk", () => {
    expect(
      gentleAiReviewStoreSummary({
        report: {
          operation: "review/store-reset",
          repository: "/a",
          store_root: "/a/.git/gentle",
          removable: [entry(true, 1024), entry(false, 99), entry(true, 1024)],
          preserved: [entry(true, 5)],
          unrecognized: [],
          in_flight: [{}],
          settled_lineages: 0,
          removed_files: 0,
          removed_bytes: 0,
          complete: false,
        },
      }),
    ).toEqual({ removable: 2, removableBytes: 2048, inFlight: 1 });
  });

  it("formats sizes", () => {
    expect(formatGentleAiBytes(512)).toBe("512 B");
    expect(formatGentleAiBytes(2048)).toBe("2.0 KB");
  });
});

describe("uninstall params", () => {
  it("sends no lists for full modes", () => {
    expect(
      gentleAiUninstallPlanParams({ mode: "full", agents: ["codex"], components: ["sdd"] }, "/a"),
    ).toEqual({ mode: "full", cwd: "/a" });
  });

  it("requires agents and components for a partial uninstall", () => {
    expect(
      gentleAiUninstallPlanParams({ mode: "partial", agents: ["codex"], components: [] }, "/a"),
    ).toBeNull();
    expect(
      gentleAiUninstallPlanParams(
        { mode: "partial", agents: ["codex"], components: ["sdd"] },
        "/a",
      ),
    ).toEqual({ mode: "partial", agents: ["codex"], components: ["sdd"], cwd: "/a" });
  });

  it("works without a project, which only scopes project cleanup", () => {
    expect(
      gentleAiUninstallPlanParams(
        { mode: "partial", agents: ["codex"], components: ["sdd"] },
        null,
      ),
    ).toEqual({ mode: "partial", agents: ["codex"], components: ["sdd"] });
  });

  it("adds the plan's choices to the run", () => {
    expect(gentleAiUninstallRunParams({ mode: "full", cwd: "/a" }, { engramScope: null })).toEqual({
      mode: "full",
      cwd: "/a",
    });
    expect(
      gentleAiUninstallRunParams({ mode: "full", cwd: "/a" }, { engramScope: "project" }),
    ).toEqual({ mode: "full", cwd: "/a", engramScope: "project" });
  });
});

describe("toggleGentleAiId", () => {
  it("adds and removes ids in source order", () => {
    const order = ["a", "b", "c"];
    expect(toggleGentleAiId(order, ["c"], "a")).toEqual(["a", "c"]);
    expect(toggleGentleAiId(order, ["a", "c"], "a")).toEqual(["c"]);
  });
});
