import { describe, expect, it } from "vite-plus/test";

import { gentleAiFlowKey, parseGentleAiFlow, type GentleAiFlow } from "./gentleAiFlow.logic";

describe("Gentle AI flow keys", () => {
  it("round-trips every flow through the URL", () => {
    const flows: ReadonlyArray<GentleAiFlow> = [
      { kind: "agent", agent: "pi" },
      { kind: "setup" },
      { kind: "setup", agent: "codex" },
      { kind: "uninstall" },
      { kind: "uninstall", agent: "opencode" },
      { kind: "models", agent: "claude-code" },
      { kind: "builder" },
      { kind: "backups" },
      { kind: "doctor" },
    ];
    for (const flow of flows) expect(parseGentleAiFlow(gentleAiFlowKey(flow))).toEqual(flow);
  });

  it("sends old Claude Code profile links to its agent page", () => {
    expect(parseGentleAiFlow("claudeProfiles")).toEqual({ kind: "agent", agent: "claude-code" });
  });

  it("rejects unknown flows and a models flow without an agent", () => {
    for (const value of [
      "models",
      "models:",
      "agent",
      "agent:",
      "profiles",
      "doctor:codex",
      "",
      1,
      undefined,
    ]) {
      expect(parseGentleAiFlow(value)).toBeNull();
    }
  });
});
