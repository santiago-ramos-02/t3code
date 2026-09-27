import { describe, expect, it } from "vite-plus/test";

import {
  gentleAiAgentList,
  gentleAiModelAgent,
  gentleAiModelsAllDefault,
  gentleAiSyncNeeded,
} from "./gentleAi.ts";

const agent = (
  id: string,
  flags: { detected?: boolean; installed?: boolean; supported?: boolean },
) => ({
  id,
  name: id.toUpperCase(),
  detected: flags.detected ?? false,
  installed: flags.installed ?? false,
  supported: flags.supported ?? true,
  configPath: "",
});

describe("gentleAiAgentList", () => {
  it("lists set-up agents first, then detected ones, and leaves out the rest", () => {
    const agents = [
      agent("claude-code", { detected: true }),
      agent("cursor", {}),
      agent("opencode", { detected: true, installed: true }),
      agent("windsurf", { detected: true, supported: false }),
      agent("pi", { installed: true }),
    ];
    expect(gentleAiAgentList({ agents }).map((entry) => [entry.id, entry.state])).toEqual([
      ["opencode", "set-up"],
      ["pi", "set-up"],
      ["claude-code", "available"],
      ["windsurf", "unsupported"],
    ]);
  });
});

describe("gentleAiModelAgent", () => {
  it("names only the agents gentle-ai configures models for", () => {
    expect(gentleAiModelAgent("codex")).toBe("codex");
    expect(gentleAiModelAgent("pi")).toBeNull();
  });
});

describe("gentleAiModelsAllDefault", () => {
  it("is true only while no phase has a model assigned", () => {
    expect(gentleAiModelsAllDefault({})).toBe(true);
    expect(gentleAiModelsAllDefault({ modelAssignments: {}, targetAgents: [] })).toBe(true);
    expect(gentleAiModelsAllDefault({ codexModelAssignments: { "odd-worker": "high" } })).toBe(
      false,
    );
    expect(
      gentleAiModelsAllDefault({ codexOrchestratorAssignment: { model: "gpt", effort: "high" } }),
    ).toBe(false);
  });
});

describe("gentleAiSyncNeeded", () => {
  it("prefers gentle-ai's own answer, which also counts a version change", () => {
    const state = (fields: { pendingSync: boolean; syncNeeded?: boolean }) => ({
      state: { ...fields, background: {} },
    });
    expect(gentleAiSyncNeeded(state({ pendingSync: false, syncNeeded: true }))).toBe(true);
    expect(gentleAiSyncNeeded(state({ pendingSync: true, syncNeeded: false }))).toBe(false);
    // Builds before syncNeeded report only a pending sync.
    expect(gentleAiSyncNeeded(state({ pendingSync: true }))).toBe(true);
  });
});
