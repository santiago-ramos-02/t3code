import { describe, expect, it } from "vite-plus/test";

import {
  gentleAiScopeProject,
  gentleAiToolInstalled,
  gentleAiToolSummary,
  gentleAiUninstallPlanParams,
  gentleAiUninstallRunParams,
  toggleGentleAiId,
} from "./gentleAiSections.logic";

const member = (id: string, environmentId: string, workspaceRoot: string) => ({
  id,
  environmentId,
  workspaceRoot,
});

describe("gentleAiScopeProject", () => {
  const group = { displayName: "MappStock" };
  const members = [member("p1", "env-a", "/a/mappstock"), member("p2", "env-b", "/b/mappstock")];

  it("acts on the scoped project's folder on the page's environment", () => {
    expect(gentleAiScopeProject({ kind: "project", group, members }, "env-b")).toEqual({
      title: "MappStock",
      cwd: "/b/mappstock",
    });
  });

  it("acts on a chosen checkout as is", () => {
    expect(
      gentleAiScopeProject({ kind: "checkout", group, checkout: members[0]! }, "env-a"),
    ).toEqual({ title: "MappStock", cwd: "/a/mappstock" });
  });

  it("has no project for every-project scopes or a project missing here", () => {
    expect(gentleAiScopeProject({ kind: "all" }, "env-a")).toBeNull();
    expect(
      gentleAiScopeProject({ kind: "project", group, members: [members[0]!] }, "env-b"),
    ).toBeNull();
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

  it("takes gentle-ai's word for whether a tool is installed", () => {
    // Pi's wiring cannot be verified, so a tool can be installed with an agent unconfirmed.
    expect(gentleAiToolInstalled({ ...tool, installed: true })).toBe(true);
    expect(gentleAiToolInstalled({ ...tool, cliAvailable: false, installed: false })).toBe(false);
  });

  it("works it out from the agents when gentle-ai does not say", () => {
    expect(gentleAiToolInstalled(tool)).toBe(false);
    expect(
      gentleAiToolInstalled({ ...tool, agents: tool.agents.filter((a) => a.agent !== "codex") }),
    ).toBe(true);
  });

  it("names agents the way gentle-ai does", () => {
    expect(
      gentleAiToolSummary(
        { ...tool, agents: [{ agent: "codex", name: "Codex", detected: true, configured: false }] },
        new Map(),
      ),
    ).toBe("CLI installed · Not configured for Codex");
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
