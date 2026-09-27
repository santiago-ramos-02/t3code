import type { GentleAiApiStatus, GentleAiPlan } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CUSTOM_PRESET, initialSetupDraft, installParams } from "./gentleAiSetup.logic";

const agent = (id: string, flags: { detected?: boolean; installed?: boolean } = {}) => ({
  id,
  name: id,
  detected: flags.detected ?? false,
  installed: flags.installed ?? false,
  supported: true,
  configPath: `/home/${id}`,
});

const status = (overrides: Partial<GentleAiApiStatus> = {}): GentleAiApiStatus => ({
  version: "3.8.0",
  system: { os: "linux", arch: "amd64", shell: "bash", supported: true },
  agents: [
    agent("claude-code", { detected: true }),
    agent("codex", { detected: true }),
    agent("cursor"),
  ],
  components: [
    { id: "engram", name: "Engram", description: "", installed: false, requires: [] },
    { id: "sdd", name: "SDD", description: "", installed: false, requires: ["engram"] },
  ],
  presets: [{ id: "full-gentleman", label: "Dev Stack + Polish", components: ["engram", "sdd"] }],
  personas: [{ id: "gentleman", label: "gentleman" }],
  skills: [],
  state: { pendingSync: false, background: {} },
  openCodeDetected: false,
  builderEngines: [],
  ...overrides,
});

const plan = (questions: ReadonlyArray<string>): GentleAiPlan => ({
  agents: ["claude-code", "codex"],
  unsupportedAgents: [],
  components: ["engram", "sdd"],
  addedDependencies: [],
  steps: [],
  questions,
});

describe("setup wizard", () => {
  it("starts from what gentle-ai set up, else what it detects", () => {
    expect(initialSetupDraft(status()).agents).toEqual(["claude-code", "codex"]);
    const setUp = status({
      agents: [
        agent("claude-code", { detected: true }),
        agent("codex", { detected: true, installed: true }),
      ],
      state: {
        preset: "full-gentleman",
        rddMode: "off",
        pendingSync: false,
        background: { pi: "on" },
      },
    });
    expect(initialSetupDraft(setUp)).toMatchObject({
      agents: ["codex"],
      preset: "full-gentleman",
      rdd: false,
      background: { opencode: "auto", pi: "on" },
    });
    // Adding one agent keeps the agents already set up, so the install does not drop them.
    expect(initialSetupDraft(setUp, "claude-code").agents).toEqual(["codex", "claude-code"]);
    expect(initialSetupDraft(setUp, "codex").agents).toEqual(["codex"]);
  });

  it("sends only what the plan asks, with model presets and custom models apart", () => {
    const draft = {
      ...initialSetupDraft(status()),
      models: {
        "claude-code": { preset: "balanced" },
        codex: { models: { codexModelAssignments: { "sdd-apply": "high" } } },
        // A leftover choice for an agent the plan no longer asks about is dropped.
        opencode: { preset: "economy" },
      },
    };
    // Community tools are never sent, so gentle-ai keeps the ones already recorded.
    expect(
      installParams(
        status(),
        draft,
        plan(["claudeModels", "codexModels", "rdd", "communityTools"]),
      ),
    ).toEqual({
      selection: {
        agents: ["claude-code", "codex"],
        persona: "gentleman",
        preset: "full-gentleman",
      },
      modelPresets: { "claude-code": "balanced" },
      models: { codexModelAssignments: { "sdd-apply": "high" } },
      rdd: true,
    });
  });

  it("names components and skills only for the custom preset", () => {
    const draft = {
      ...initialSetupDraft(status()),
      preset: CUSTOM_PRESET,
      components: ["engram"],
    };
    expect(installParams(status(), draft, plan([])).selection).toMatchObject({
      preset: CUSTOM_PRESET,
      components: ["engram"],
    });
  });
});
