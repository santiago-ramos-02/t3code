import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import {
  claudeProfileSlotModels,
  gentleAiAgentList,
  gentleAiClaudeProfileSummary,
  gentleAiModelAgent,
  gentleAiModelsAllDefault,
  gentleAiSyncNeeded,
  gentleOddContinuePrompt,
  gentleOddFeatureSummary,
  gentlePiProfileSummary,
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

describe("ODD features", () => {
  it("resumes a feature from its document and summarizes where it stands", () => {
    expect(gentleOddContinuePrompt({ path: "odd/tasks/due-dates.md" })).toBe(
      "Implement odd/tasks/due-dates.md.",
    );
    expect(gentleOddFeatureSummary({ tasksDone: 2, tasksTotal: 3, nextStep: "Start T3." })).toBe(
      "2 of 3 tasks done · Next: Start T3.",
    );
    expect(gentleOddFeatureSummary({ tasksDone: 3, tasksTotal: 3 })).toBe("All 3 tasks done");
    expect(gentleOddFeatureSummary({ tasksDone: 0, tasksTotal: 0 })).toBe("No tasks yet");
  });
});

describe("gentleAiClaudeProfileSummary", () => {
  it("names what each slot runs, strongest first, and who picks the phases' models", () => {
    expect(
      gentleAiClaudeProfileSummary({
        slots: {
          haiku: { model: "gpt-6-luna", label: "GPT-6 Luna" },
          opus: { model: "claude-opus-5-5" },
        },
      }),
    ).toBe("opus → claude-opus-5-5 · haiku → GPT-6 Luna · Claude picks models per task");
    expect(
      gentleAiClaudeProfileSummary({ slots: {}, phases: { "odd-worker": { model: "sonnet" } } }),
    ).toBe("1 phase pinned");
  });
});

describe("claudeProfileSlotModels", () => {
  it("offers what Claude Code providers going through a proxy serve, once each", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const proxy = [
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", sensitive: false },
    ];
    expect(
      claudeProfileSlotModels({
        cliproxy: {
          driver: claude,
          environment: proxy,
          config: {
            customModels: [{ slug: "claude-fable-5-dd-anul-6-tpg", name: "GPT 6.0 Luna" }, "muse"],
          },
        },
        other: {
          driver: claude,
          environment: [
            { name: "ANTHROPIC_BASE_URL", value: "", sensitive: false, valueRedacted: true },
          ],
          config: { customModels: ["muse"] },
        },
        direct: { driver: claude, config: { customModels: ["claude-opus-5-5"] } },
        off: {
          driver: claude,
          environment: proxy,
          enabled: false,
          config: { customModels: ["off"] },
        },
        codex: {
          driver: ProviderDriverKind.make("codex"),
          environment: proxy,
          config: { customModels: ["gpt"] },
        },
      }),
    ).toEqual([
      { id: "claude-fable-5-dd-anul-6-tpg", label: "GPT 6.0 Luna" },
      { id: "muse", label: "muse" },
    ]);
  });
});

describe("gentlePiProfileSummary", () => {
  it("names the orchestrator's model and counts the subagent roles", () => {
    const names = new Map([["claude-bridge/claude-opus-5-5", "Claude Opus 5.5"]]);
    expect(
      gentlePiProfileSummary(
        {
          orchestrator: { model: "claude-bridge/claude-opus-5-5", thinking: "medium" },
          "gentle-ai-explore": { model: "claude-bridge/claude-sonnet-5" },
          "gentle-ai-worker": {},
        },
        (model) => names.get(model),
      ),
    ).toBe("Claude Opus 5.5 leads · 2 subagent roles");
    expect(
      gentlePiProfileSummary({ orchestrator: { model: "x/unknown-model" } }, () => undefined),
    ).toBe("unknown-model leads · no subagent roles");
    expect(gentlePiProfileSummary({}, () => undefined)).toBe(
      "Pi's own model leads · no subagent roles",
    );
  });
});
